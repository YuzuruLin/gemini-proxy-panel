// --- Transformation logic migrated from Cloudflare Worker ---

/**
 * Parses a data URI string.
 * @param {string} dataUri - The data URI (e.g., "data:image/jpeg;base64,...").
 * @returns {{ mimeType: string; data: string } | null} Parsed data or null if invalid.
 */
function parseDataUri(dataUri) {
    if (!dataUri) return null;
	const match = dataUri.match(/^data:(.+?);base64,(.+)$/);
	if (!match) return null;
	return { mimeType: match[1], data: match[2] };
}

/**
 * Transforms an OpenAI-compatible request body to the Gemini API format.
 * @param {object} requestBody - The OpenAI request body.
 * @param {string} [requestedModelId] - The specific model ID requested.
 * @param {boolean} [isSafetyEnabled=true] - Whether safety filtering is enabled for this request.
 * @returns {{ contents: any[]; systemInstruction?: any; tools?: any[] }} Gemini formatted request parts.
 */
function transformOpenAiToGemini(requestBody, requestedModelId, isSafetyEnabled = true) {
	const messages = requestBody.messages || [];
	const openAiTools = requestBody.tools;

	// 1. Transform Messages
	const contents = [];
	let systemInstruction = undefined;

	messages.forEach((msg) => {
		let role = undefined;
		let parts = [];

		// 1. Map Role
		switch (msg.role) {
			case 'user':
				role = 'user';
				break;
			case 'assistant':
				role = 'model';
				break;
			case 'system':
                // If safety is disabled OR it's a gemma model, treat system as user
                if (isSafetyEnabled === false || (requestedModelId && requestedModelId.startsWith('gemma'))) {
                    console.log(`Safety disabled (${isSafetyEnabled}) or Gemma model detected (${requestedModelId}). Treating system message as user message.`);
                    role = 'user';
                    // Content processing for 'user' role will happen below
                }
                // Otherwise (safety enabled and not gemma), create systemInstruction
                else {
                    if (typeof msg.content === 'string') {
                        systemInstruction = { role: "system", parts: [{ text: msg.content }] };
                    } else if (Array.isArray(msg.content)) { // Handle complex system prompts if needed
                        const textContent = msg.content.find((p) => p.type === 'text')?.text;
                        if (textContent) {
                            systemInstruction = { role: "system", parts: [{ text: textContent }] };
                        }
                    }
                    return; // Skip adding this message to 'contents' when creating systemInstruction
                }
                break; // Break for 'system' role (safety disabled/gemma case falls through to content processing)
			default:
				console.warn(`Unknown role encountered: ${msg.role}. Skipping message.`);
				return; // Skip unknown roles
		}

		// 2. Map Content to Parts
		if (typeof msg.content === 'string') {
			parts.push({ text: msg.content });
		} else if (Array.isArray(msg.content)) {
			// Handle multi-part messages (text and images)
			msg.content.forEach((part) => {
				if (part.type === 'text') {
					parts.push({ text: part.text });
				} else if (part.type === 'image_url') {
                    // In Node.js, image_url might just contain the URL, or a data URI
                    // Assuming it follows the OpenAI spec and provides a URL field within image_url
                    const imageUrl = part.image_url?.url;
                    if (!imageUrl) {
                        console.warn(`Missing url in image_url part. Skipping image part.`);
                        return;
                    }
					const imageData = parseDataUri(imageUrl); // Attempt to parse as data URI
					if (imageData) {
						parts.push({ inlineData: { mimeType: imageData.mimeType, data: imageData.data } }); // Structure expected by Gemini
					} else {
                        // If it's not a data URI, we can't directly include it as inlineData.
                        // Gemini API (currently) doesn't support fetching from URLs directly in the standard API.
                        // Consider alternatives:
                        // 1. Pre-fetch the image data server-side (adds complexity, requires fetch).
                        // 2. Reject requests with image URLs (simpler for now).
                        console.warn(`Image URL is not a data URI: ${imageUrl}. Gemini API requires inlineData (base64). Skipping image part.`);
                        // Decide how to handle this. For now, we skip.
                        // parts.push({ text: `[Unsupported Image URL: ${imageUrl}]` }); // Optional: replace with text placeholder
					}
				} else {
					console.warn(`Unknown content part type: ${part.type}. Skipping part.`);
				}
			});
		} else {
			console.warn(`Unsupported content type for role ${msg.role}: ${typeof msg.content}. Skipping message.`);
			return;
		}

		// Add the transformed message to contents if it has a role and parts
		if (role && parts.length > 0) {
			contents.push({ role, parts });
		}
	});

	// 2. Transform Tools
	let geminiTools = undefined;
	if (openAiTools && Array.isArray(openAiTools) && openAiTools.length > 0) {
		const functionDeclarations = openAiTools
			.filter(tool => tool.type === 'function' && tool.function)
			.map(tool => {
                // Deep clone parameters to avoid modifying the original request object
                const parameters = tool.function.parameters ? JSON.parse(JSON.stringify(tool.function.parameters)) : undefined;
                // Remove the $schema field if it exists in the clone
                if (parameters && parameters.$schema !== undefined) {
                    delete parameters.$schema;
                    console.log(`Removed '$schema' from parameters for tool: ${tool.function.name}`);
                }
				return {
					name: tool.function.name,
					description: tool.function.description,
					parameters: parameters
				};
			});

		if (functionDeclarations.length > 0) {
			geminiTools = [{ functionDeclarations }];
		}
	}

	return { contents, systemInstruction, tools: geminiTools };
}


/**
 * Transforms a single Gemini API stream chunk into an OpenAI-compatible SSE chunk.
 * @param {object} geminiChunk - The parsed JSON object from a Gemini stream line.
 * @param {string} modelId - The model ID used for the request.
 * @returns {string | null} An OpenAI SSE data line string ("data: {...}\n\n") or null if chunk is empty/invalid.
 */
function transformGeminiStreamChunk(geminiChunk, modelId) {
	try {
		if (!geminiChunk || !geminiChunk.candidates || !geminiChunk.candidates.length) {
            // Ignore chunks that only contain usageMetadata (often appear at the end)
            if (geminiChunk?.usageMetadata) {
                return null;
            }
			console.warn("Received empty or invalid Gemini stream chunk:", JSON.stringify(geminiChunk));
			return null; // Skip empty/invalid chunks
		}

		const candidate = geminiChunk.candidates[0];
		let contentText = null;
		let toolCalls = undefined;

		// Extract text content and function calls
        if (candidate.content?.parts?.length > 0) {
            const textParts = candidate.content.parts.filter((part) => part.text !== undefined);
            const functionCallParts = candidate.content.parts.filter((part) => part.functionCall !== undefined);

            if (textParts.length > 0) {
                contentText = textParts.map((part) => part.text).join("");
            }

            if (functionCallParts.length > 0) {
                // Generate unique IDs for tool calls within the stream context if needed,
                // or use a simpler identifier if absolute uniqueness isn't critical across chunks.
                toolCalls = functionCallParts.map((part, index) => ({
                    index: index, // Gemini doesn't provide a stable index in stream AFAIK, use loop index
                    id: `call_${part.functionCall.name}_${Date.now()}_${index}`, // Example ID generation
                    type: "function",
                    function: {
                        name: part.functionCall.name,
                        // Arguments in Gemini stream might be partial JSON, attempt to stringify
                        arguments: JSON.stringify(part.functionCall.args || {}),
                    },
                }));
            }
        }

		// Determine finish reason mapping
		let finishReason = candidate.finishReason;
        if (finishReason === "STOP") finishReason = "stop";
        else if (finishReason === "MAX_TOKENS") finishReason = "length";
        else if (finishReason === "SAFETY" || finishReason === "RECITATION") finishReason = "content_filter";
        else if (finishReason === "TOOL_CALLS" || (toolCalls && toolCalls.length > 0 && finishReason !== 'stop' && finishReason !== 'length')) {
            // If there are tool calls and the reason isn't stop/length, map it to tool_calls
            finishReason = "tool_calls";
        } else if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED" && finishReason !== "OTHER") {
            // Keep known reasons like 'stop', 'length', 'content_filter'
        } else {
            finishReason = null; // Map unspecified/other/null to null
        }


		// Construct the delta part for the OpenAI chunk
		const delta = {};
        // Include role only if there's actual content or tool calls in this chunk
        if (candidate.content?.role && (contentText !== null || (toolCalls && toolCalls.length > 0))) {
            delta.role = candidate.content.role === 'model' ? 'assistant' : candidate.content.role;
        }

        if (toolCalls && toolCalls.length > 0) {
            delta.tool_calls = toolCalls;
             // IMPORTANT: Explicitly set content to null if there are tool_calls but no text content in THIS chunk
             // This aligns with OpenAI's behavior where a chunk might contain only tool_calls.
            if (contentText === null) {
                delta.content = null;
            } else {
                 delta.content = contentText; // Include text if it also exists
            }
        } else if (contentText !== null) {
             // Only include content if there's text and no tool calls in this chunk
            delta.content = contentText;
        }


		// Only create a chunk if there's something meaningful to send
		if (Object.keys(delta).length === 0 && !finishReason) {
			return null;
		}

		const openaiChunk = {
			id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`, // More unique ID
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: candidate.index || 0,
					delta: delta,
					finish_reason: finishReason, // Use the mapped finishReason
                    logprobs: null, // Not provided by Gemini
				},
			],
            // Usage is typically not included in stream chunks, only at the end if at all
		};

		return `data: ${JSON.stringify(openaiChunk)}\n\n`;

	} catch (e) {
		console.error("Error transforming Gemini stream chunk:", e, "Chunk:", JSON.stringify(geminiChunk));
        // Optionally return an error chunk
        const errorChunk = {
            id: `chatcmpl-error-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, delta: { content: `[Error transforming chunk: ${e.message}]` }, finish_reason: 'error' }]
        };
        return `data: ${JSON.stringify(errorChunk)}\n\n`;
	}
}


/**
 * Transforms a complete (non-streaming) Gemini API response into an OpenAI-compatible format.
 * @param {object} geminiResponse - The parsed JSON object from the Gemini API response.
 * @param {string} modelId - The model ID used for the request.
 * @returns {string} A JSON string representing the OpenAI-compatible response.
 */
function transformGeminiResponseToOpenAI(geminiResponse, modelId) {
	try {
        // Handle cases where the response indicates an error (e.g., blocked prompt)
        if (!geminiResponse.candidates || geminiResponse.candidates.length === 0) {
            let errorMessage = "Gemini response missing candidates.";
            let finishReason = "error"; // Default error finish reason

            // Check for prompt feedback indicating blocking
            if (geminiResponse.promptFeedback?.blockReason) {
                errorMessage = `Request blocked by Gemini: ${geminiResponse.promptFeedback.blockReason}.`;
                finishReason = "content_filter"; // More specific finish reason
                 console.warn(`Gemini request blocked: ${geminiResponse.promptFeedback.blockReason}`, JSON.stringify(geminiResponse.promptFeedback));
            } else {
                console.error("Invalid Gemini response structure:", JSON.stringify(geminiResponse));
            }

            // Construct an error response in OpenAI format
            const errorResponse = {
                id: `chatcmpl-error-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    message: { role: "assistant", content: errorMessage },
                    finish_reason: finishReason,
                    logprobs: null,
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            return JSON.stringify(errorResponse);
        }


		const candidate = geminiResponse.candidates[0];
		let contentText = null;
		let toolCalls = undefined;

		// Extract content and tool calls
		if (candidate.content?.parts?.length > 0) {
            const textParts = candidate.content.parts.filter((part) => part.text !== undefined);
            const functionCallParts = candidate.content.parts.filter((part) => part.functionCall !== undefined);

            if (textParts.length > 0) {
                contentText = textParts.map((part) => part.text).join("");
            }

            if (functionCallParts.length > 0) {
                toolCalls = functionCallParts.map((part, index) => ({
                    id: `call_${part.functionCall.name}_${Date.now()}_${index}`, // Example ID
                    type: "function",
                    function: {
                        name: part.functionCall.name,
                        // Arguments should be a stringified JSON in OpenAI format
                        arguments: JSON.stringify(part.functionCall.args || {}),
                    },
                }));
            }
        }

		// Map finish reason
		let finishReason = candidate.finishReason;
        if (finishReason === "STOP") finishReason = "stop";
        else if (finishReason === "MAX_TOKENS") finishReason = "length";
        else if (finishReason === "SAFETY" || finishReason === "RECITATION") finishReason = "content_filter";
        else if (finishReason === "TOOL_CALLS") finishReason = "tool_calls"; // Explicitly check for TOOL_CALLS
        else if (toolCalls && toolCalls.length > 0) {
             // If tools were called but reason is not TOOL_CALLS (e.g., STOP), still map to tool_calls
            finishReason = "tool_calls";
        } else if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED" && finishReason !== "OTHER") {
            // Keep known reasons
        } else {
             finishReason = null; // Map unspecified/other to null
        }

        // Handle cases where content might be missing due to safety ratings, even if finishReason isn't SAFETY
        if (contentText === null && !toolCalls && candidate.finishReason === "SAFETY") {
             console.warn("Gemini response finished due to SAFETY, content might be missing.");
             contentText = "[Content blocked due to safety settings]";
             finishReason = "content_filter";
        } else if (candidate.finishReason === "RECITATION") {
             console.warn("Gemini response finished due to RECITATION.");
             // contentText might exist but could be partial/problematic
             finishReason = "content_filter"; // Map recitation to content_filter
        }


		// Construct the OpenAI message object
		const message = { role: "assistant" };
        if (toolCalls && toolCalls.length > 0) {
             message.tool_calls = toolCalls;
             // IMPORTANT: Set content to null if only tool calls exist, otherwise include text
             message.content = contentText !== null ? contentText : null;
        } else {
             message.content = contentText; // Assign text content if no tool calls
        }
         // Ensure content is at least null if nothing else was generated
         if (message.content === undefined && !message.tool_calls) {
            message.content = null;
         }


		// Map usage metadata
		const usage = {
			prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
			completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0, // Sum across candidates if multiple
			total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
		};

		// Construct the final OpenAI response object
		const openaiResponse = {
			id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: candidate.index || 0,
					message: message,
					finish_reason: finishReason,
                    logprobs: null, // Not provided by Gemini
				},
			],
			usage: usage,
            // Include system fingerprint if available (though Gemini doesn't provide one)
            system_fingerprint: null
		};

		return JSON.stringify(openaiResponse);

	} catch (e) {
		console.error("Error transforming Gemini non-stream response:", e, "Response:", JSON.stringify(geminiResponse));
		// Return an error structure in OpenAI format
		const errorResponse = {
			id: `chatcmpl-error-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [{
				index: 0,
				message: { role: "assistant", content: `Error processing Gemini response: ${e.message}` },
				finish_reason: "error",
                logprobs: null,
			}],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		};
		return JSON.stringify(errorResponse);
	}
}


module.exports = {
    parseDataUri,
    transformOpenAiToGemini,
    transformGeminiStreamChunk,
    transformGeminiResponseToOpenAI,
};
