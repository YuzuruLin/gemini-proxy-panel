// src/routes/apiV1.js

const express = require('express');
const { Readable, Transform } = require('stream'); // For handling streams and transforming
const requireWorkerAuth = require('../middleware/workerAuth');
const geminiProxyService = require('../services/geminiProxyService');
const configService = require('../services/configService'); // For /v1/models
const transformUtils = require('../utils/transform');

const router = express.Router();

// Apply worker authentication middleware to all /v1 routes
router.use(requireWorkerAuth);

// --- /v1/models ---
router.get('/models', async (req, res, next) => {
    try {
        const modelsConfig = await configService.getModelsConfig();
        const modelsData = Object.keys(modelsConfig).map(modelId => ({
            id: modelId,
            object: "model",
            created: Math.floor(Date.now() / 1000), // Placeholder timestamp
            owned_by: "google", // Assuming all configured models are Google's
            // Add other relevant properties if available/needed
        }));

        res.json({ object: "list", data: modelsData });
    } catch (error) {
        console.error("Error handling /v1/models:", error);
        next(error); // Pass to global error handler
    }
});

// --- /v1/chat/completions ---
router.post('/chat/completions', async (req, res, next) => {
    const openAIRequestBody = req.body;
    const workerApiKey = req.workerApiKey; // Attached by requireWorkerAuth middleware
    const stream = openAIRequestBody?.stream ?? false;
    const requestedModelId = openAIRequestBody?.model; // Keep track for transformations

    try {
        // Call the proxy service
        const result = await geminiProxyService.proxyChatCompletions(
            openAIRequestBody,
            workerApiKey,
            stream
        );

        // Check if the service returned an error
        if (result.error) {
            // Ensure Content-Type is set for error responses
            res.setHeader('Content-Type', 'application/json');
            return res.status(result.status || 500).json({ error: result.error });
        }

        // Destructure the successful result
        const { response: geminiResponse, selectedKeyId, modelCategory } = result;

        // --- Handle Response ---

        // Set common headers
        res.setHeader('X-Proxied-By', 'gemini-proxy-panel-node');
        res.setHeader('X-Selected-Key-ID', selectedKeyId); // Send back which key was used (optional)

        if (stream) {
            // --- Streaming Response ---
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            // Apply CORS headers if not already handled globally by middleware
            // res.setHeader('Access-Control-Allow-Origin', '*'); // Example if needed


            // Ensure geminiResponse.body is a readable stream
            if (!geminiResponse.body || typeof geminiResponse.body.pipe !== 'function') {
                console.error('Gemini response body is not a readable stream for streaming request.');
                 // Send a valid SSE error event before closing
                 const errorPayload = JSON.stringify({ error: { message: 'Upstream response body is not readable.', type: 'proxy_error' } });
                 res.write(`data: ${errorPayload}\n\n`);
                 res.write('data: [DONE]\n\n');
                return res.end();
            }

            const decoder = new TextDecoder();
            let buffer = '';
            let lineBuffer = '';
            let jsonCollector = '';
            let isCollectingJson = false;
            let openBraces = 0;
            let closeBraces = 0;

            // Implement a truly real-time stream processing transformer
            const streamTransformer = new Transform({
                transform(chunk, encoding, callback) {
                    try {
                        // Decode the received data chunk
                        const chunkStr = decoder.decode(chunk, { stream: true });
                        // Add the current chunk to the buffer
                        buffer += chunkStr;
                        
                        // Try to extract complete JSON objects from the buffer
                        let startPos = -1;
                        let endPos = -1;
                        let bracketDepth = 0;
                        let inString = false;
                        let escapeNext = false;
                        
                        // Scan the entire buffer to find complete JSON objects
                        for (let i = 0; i < buffer.length; i++) {
                            const char = buffer[i];
                            
                            // Handle characters within strings
                            if (inString) {
                                if (escapeNext) {
                                    escapeNext = false;
                                } else if (char === '\\') {
                                    escapeNext = true;
                                } else if (char === '"') {
                                    inString = false;
                                }
                                continue;
                            }
                            
                            // Handle characters outside strings
                            if (char === '{') {
                                if (bracketDepth === 0) {
                                    startPos = i; // Record the starting position of a new JSON object
                                }
                                bracketDepth++;
                            } else if (char === '}') {
                                bracketDepth--;
                                if (bracketDepth === 0 && startPos !== -1) {
                                    endPos = i;
                                    
                                    // Extract and process the complete JSON object
                                    const jsonStr = buffer.substring(startPos, endPos + 1);
                                    try {
                                        const jsonObj = JSON.parse(jsonStr);
                                        // Immediately process and send this object
                                        processGeminiObject(jsonObj, this);
                                    } catch (e) {
                                        console.error("Error parsing JSON object:", e);
                                    }
                                    
                                    // Continue searching for the next object
                                    startPos = -1;
                                }
                            } else if (char === '"') {
                                inString = true;
                            } else if (char === '[' && !inString && startPos === -1) {
                                // Ignore the start marker of JSON arrays, as we process each object individually
                                continue;
                            } else if (char === ']' && !inString && bracketDepth === 0) {
                                // Ignore the end marker of JSON arrays
                                continue;
                            } else if (char === ',') {
                                // If there's a comma after an object, continue processing the next object
                                continue;
                            }
                        }
                        
                        // Keep the unprocessed part (possibly an incomplete JSON object)
                        if (startPos !== -1 && endPos !== -1 && endPos > startPos) {
                            buffer = buffer.substring(endPos + 1);
                        } else if (startPos !== -1) {
                            // Has a start but no end, keep the entire object part
                            buffer = buffer.substring(startPos);
                        } else {
                            // No incomplete JSON objects left, clear the buffer
                            buffer = '';
                        }
                        
                        callback();
                    } catch (e) {
                        console.error("Error in stream transform:", e);
                        callback(e);
                    }
                },
                
                flush(callback) {
                    try {
                        // Process any remaining buffer data
                        if (buffer.trim()) {
                            try {
                                // Try to parse the last potentially incomplete object
                                const jsonObj = JSON.parse(buffer);
                                processGeminiObject(jsonObj, this);
                            } catch (e) {
                                console.debug("Could not parse final buffer:", buffer);
                            }
                        }
                        
                        // Send the final [DONE] event
                        this.push('data: [DONE]\n\n');
                        callback();
                    } catch (e) {
                        console.error("Error in stream flush:", e);
                        callback(e);
                    }
                }
            });
            
            // Process a single Gemini API response object and convert it to OpenAI format
            function processGeminiObject(geminiObj, stream) {
                if (!geminiObj) return;
                
                // If it's a valid Gemini response object (contains candidates)
                if (geminiObj.candidates && geminiObj.candidates.length > 0) {
                    // Convert and send directly
                    const openaiChunkStr = transformUtils.transformGeminiStreamChunk(geminiObj, requestedModelId);
                    if (openaiChunkStr) {
                        stream.push(openaiChunkStr);
                    }
                } else if (Array.isArray(geminiObj)) {
                    // If it's an array, process each element
                    for (const item of geminiObj) {
                        processGeminiObject(item, stream);
                    }
                } else if (geminiObj.text) {
                    // Single text fragment, construct Gemini format
                    const mockGeminiChunk = {
                        candidates: [{
                            content: {
                                parts: [{ text: geminiObj.text }],
                                role: "model"
                            }
                        }]
                    };
                    
                    const openaiChunkStr = transformUtils.transformGeminiStreamChunk(mockGeminiChunk, requestedModelId);
                    if (openaiChunkStr) {
                        stream.push(openaiChunkStr);
                    }
                }
                // May need to handle other response types...
            }

            // Pipe the Gemini response body through the transformer and then to the client response
            geminiResponse.body.pipe(streamTransformer).pipe(res);

            // Handle errors on the source stream
             geminiResponse.body.on('error', (err) => {
                 console.error('Error reading stream from Gemini:', err);
                 // Try to end the response gracefully if headers not sent
                 if (!res.headersSent) {
                     res.status(500).json({ error: { message: 'Error reading stream from upstream API.' } });
                 } else {
                      // If headers sent, try to signal error within the stream (though might be too late)
                      // streamTransformer should ideally handle errors during transformation
                      res.end(); // End the connection
                 }
             });

             // Handle errors on the transformer stream
             streamTransformer.on('error', (err) => {
                 console.error('Error in stream transformer:', err);
                 if (!res.headersSent) {
                      res.status(500).json({ error: { message: 'Error processing stream data.' } });
                 } else {
                      res.end();
                 }
             });

             console.log(`Streaming response initiated for key ${selectedKeyId}`);


        } else {
            // --- Non-Streaming Response ---
            res.setHeader('Content-Type', 'application/json; charset=utf-8');

            try {
                 const geminiJson = await geminiResponse.json();
                 const openaiJsonString = transformUtils.transformGeminiResponseToOpenAI(geminiJson, requestedModelId);
                 // Use Gemini's original status code if available and OK, otherwise default to 200
                 res.status(geminiResponse.ok ? geminiResponse.status : 200).send(openaiJsonString);
                 console.log(`Non-stream request completed for key ${selectedKeyId}, status: ${geminiResponse.status}`);
            } catch (jsonError) {
                 console.error("Error parsing Gemini non-stream JSON response:", jsonError);
                 // Check if response text might give clues
                 try {
                    const errorText = await geminiResponse.text(); // Need to re-read or clone earlier
                    console.error("Gemini non-stream response text:", errorText);
                 } catch(e){}
                 next(new Error("Failed to parse upstream API response.")); // Pass to global error handler
            }
        }

    } catch (error) {
        console.error("Error in /v1/chat/completions handler:", error);
        next(error); // Pass error to the global Express error handler
    }
});

module.exports = router;
