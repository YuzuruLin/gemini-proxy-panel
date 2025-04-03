const fetch = require('node-fetch'); 
const configService = require('./configService');
const geminiKeyService = require('./geminiKeyService');
const transformUtils = require('../utils/transform');

async function proxyChatCompletions(openAIRequestBody, workerApiKey, stream) {
    const requestedModelId = openAIRequestBody?.model;

    if (!requestedModelId) {
        return { error: { message: "Missing 'model' field in request body" }, status: 400 };
    }
    if (!openAIRequestBody.messages || !Array.isArray(openAIRequestBody.messages)) {
        return { error: { message: "Missing or invalid 'messages' field in request body" }, status: 400 };
    }

    let selectedKey;
    let modelsConfig;
    let modelInfo;
    let modelCategory;
    let isSafetyEnabled;

    try {
        // 1. Get Key, Configs, Safety Settings in parallel
        [selectedKey, modelsConfig, isSafetyEnabled] = await Promise.all([
            geminiKeyService.getNextAvailableGeminiKey(requestedModelId),
            configService.getModelsConfig(),
            configService.getWorkerKeySafetySetting(workerApiKey) // Get safety setting for this worker key
        ]);

        // 2. Validate Key and Model Config
        if (!selectedKey) {
            return { error: { message: "No available Gemini API Key configured or all keys are currently rate-limited/invalid." }, status: 503 };
        }

        modelInfo = modelsConfig[requestedModelId];
        if (!modelInfo) {
            return { error: { message: `Model '${requestedModelId}' is not configured in the proxy.` }, status: 400 };
        }
        modelCategory = modelInfo.category;

        console.log(`Proxying request for model: ${requestedModelId}, Category: ${modelCategory}, KeyID: ${selectedKey.id}, Safety: ${isSafetyEnabled}`);

        // 3. Transform Request Body
        const { contents, systemInstruction, tools: geminiTools } = transformUtils.transformOpenAiToGemini(
            openAIRequestBody,
            requestedModelId,
            isSafetyEnabled // Pass safety setting to transformer
        );

        // Basic validation after transformation
        if (contents.length === 0 && !systemInstruction) {
            // Gemini requires at least one non-system message/content part
             return { error: { message: "Request must contain at least one user or assistant message." }, status: 400 };
        }

        const geminiRequestBody = {
            contents: contents,
            generationConfig: {
                // Map OpenAI params to Gemini params
                ...(openAIRequestBody.temperature !== undefined && { temperature: openAIRequestBody.temperature }),
                ...(openAIRequestBody.top_p !== undefined && { topP: openAIRequestBody.top_p }),
                ...(openAIRequestBody.max_tokens !== undefined && { maxOutputTokens: openAIRequestBody.max_tokens }),
                ...(openAIRequestBody.stop && { stopSequences: Array.isArray(openAIRequestBody.stop) ? openAIRequestBody.stop : [openAIRequestBody.stop] }),
            },
            // Add tools and system instruction if they exist
             ...(geminiTools && { tools: geminiTools }),
             ...(systemInstruction && { systemInstruction: systemInstruction }),
        };

        // Apply safety settings if safety is disabled
        if (!isSafetyEnabled) {
             geminiRequestBody.safetySettings = [
                 { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }, 
                 { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                 { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                 { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                 { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
             ];
             console.log("Applying BLOCK_NONE safety settings.");
        }


        // 4. Prepare and Send Request to Gemini
        const apiAction = stream ? 'streamGenerateContent' : 'generateContent';
        // Use v1beta endpoint as it's commonly used and supports features like systemInstruction
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${requestedModelId}:${apiAction}?key=${selectedKey.key}`;

        const geminiRequestHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': `gemini-proxy-panel-node/1.0`, // Identify our proxy
        };

        console.log(`Sending ${stream ? 'streaming' : 'non-streaming'} request to Gemini URL: ${geminiUrl}`);
        // console.debug("Gemini Request Body:", JSON.stringify(geminiRequestBody, null, 2)); // Verbose logging

        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: geminiRequestHeaders,
            body: JSON.stringify(geminiRequestBody),
            size: 100 * 1024 * 1024, 
            timeout: 300000 
        });

        // 5. Handle Gemini Response Status and Errors
        if (!geminiResponse.ok) {
            const errorBodyText = await geminiResponse.text();
            console.error(`Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText}`, errorBodyText);

            // Handle specific errors impacting key status
            if (geminiResponse.status === 429) {
                // Don't wait for this, let it run in background
                geminiKeyService.handle429Error(selectedKey.id, modelCategory, requestedModelId)
                    .catch(err => console.error("Error handling 429 in background:", err));
            } else if (geminiResponse.status === 401 || geminiResponse.status === 403) {
                 // Don't wait for this
                geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                     .catch(err => console.error("Error recording key error in background:", err));
            }
            // No specific action needed for other errors in terms of key state

            // Return structured error to the client
            return {
                error: {
                    message: `Gemini API Error (${geminiResponse.status}): ${errorBodyText}`,
                    type: `gemini_api_error_${geminiResponse.status}`,
                    param: null,
                    code: geminiResponse.status
                },
                status: geminiResponse.status // Use Gemini's status code
            };
        }

        // 6. Process Successful Response (Streaming or Non-Streaming)
        geminiKeyService.incrementKeyUsage(selectedKey.id, requestedModelId, modelCategory)
             .catch(err => console.error("Error incrementing key usage in background:", err));

        return {
            response: geminiResponse, 
            selectedKeyId: selectedKey.id,
            modelCategory: modelCategory
         };

    } catch (error) {
        console.error("Error during Gemini API proxy call:", error);
        return {
            error: {
                message: `Internal Proxy Error: ${error.message}`,
                type: 'proxy_internal_error'
            },
            status: 500
        };
    }
}


module.exports = {
    proxyChatCompletions,
};
