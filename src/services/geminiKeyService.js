const db = require('../db');
const configService = require('./configService'); // Use configService for DB helpers and settings
const { getTodayInLA } = require('../utils/helpers');
const crypto = require('crypto'); // For generating key IDs

// --- Gemini Key CRUD Operations ---

/**
 * Adds a new Gemini API key to the database.
 * @param {string} apiKey The actual Gemini API key.
 * @param {string} [name] Optional name for the key.
 * @returns {Promise<{id: string, name: string}>} The ID and name of the added key.
 */
async function addGeminiKey(apiKey, name) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        throw new Error('Invalid API key provided.');
    }
    const trimmedApiKey = apiKey.trim();

    // Generate a unique ID
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(4).toString('hex'); // Use crypto for better randomness
    const keyId = `gk-${timestamp}-${randomString}`;
    const keyName = (typeof name === 'string' && name.trim()) ? name.trim() : keyId;

    const insertSQL = `
        INSERT INTO gemini_keys
        (id, api_key, name, usage_date, model_usage, category_usage, error_status, consecutive_429_counts, created_at)
        VALUES (?, ?, ?, '', '{}', '{}', NULL, '{}', CURRENT_TIMESTAMP)
    `;

    try {
        await configService.runDb(insertSQL, [keyId, trimmedApiKey, keyName]);

        // Add the key ID to the rotation list in settings
        const currentList = await configService.getSetting('gemini_key_list', []);
        if (!Array.isArray(currentList)) {
             console.warn("Setting 'gemini_key_list' is not an array, resetting.");
             currentList = [];
        }
        currentList.push(keyId);
        await configService.setSetting('gemini_key_list', currentList);
        console.log(`Added key ${keyId} to database and rotation list.`);

        return { id: keyId, name: keyName };
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed: gemini_keys.api_key')) {
            throw new Error('Cannot add duplicate API key.');
        }
        console.error(`Error adding Gemini key:`, err);
        throw new Error(`Failed to add Gemini key: ${err.message}`);
    }
}

/**
 * Deletes a Gemini API key from the database.
 * @param {string} keyId The ID of the key to delete.
 * @returns {Promise<void>}
 */
async function deleteGeminiKey(keyId) {
     if (!keyId || typeof keyId !== 'string' || keyId.trim() === '') {
        throw new Error('Invalid key ID provided for deletion.');
    }
    const trimmedKeyId = keyId.trim();

    // Check if key exists before deleting
    const keyExists = await configService.getDb('SELECT id FROM gemini_keys WHERE id = ?', [trimmedKeyId]);
    if (!keyExists) {
        throw new Error(`Key with ID '${trimmedKeyId}' not found.`);
    }

    // Delete key info from DB
    await configService.runDb('DELETE FROM gemini_keys WHERE id = ?', [trimmedKeyId]);

    // Remove key ID from the rotation list
    const currentList = await configService.getSetting('gemini_key_list', []);
     if (!Array.isArray(currentList)) {
         console.warn("Setting 'gemini_key_list' is not an array during delete, resetting index.");
         await configService.setSetting('gemini_key_index', 0); // Reset index if list was corrupt
         return; // Can't remove from a non-array list
     }

    const initialLength = currentList.length;
    const newList = currentList.filter(id => id !== trimmedKeyId);

    if (newList.length < initialLength) {
        await configService.setSetting('gemini_key_list', newList);
        console.log(`Removed key ${trimmedKeyId} from rotation list.`);

        // Adjust index if necessary
        let currentIndex = await configService.getSetting('gemini_key_index', 0);
        if (typeof currentIndex !== 'number') currentIndex = 0; // Handle non-numeric index

        if (newList.length === 0) {
            await configService.setSetting('gemini_key_index', 0); // Reset index if list is empty
        } else if (currentIndex >= newList.length) {
            await configService.setSetting('gemini_key_index', 0); // Reset index if it's out of bounds
        }
    } else {
        console.warn(`Key ID ${trimmedKeyId} was not found in the rotation list.`);
    }
     console.log(`Deleted Gemini key ${trimmedKeyId} from database.`);
}

/**
 * Retrieves all Gemini keys with usage details.
 * @returns {Promise<Array<object>>} Array of key objects.
 */
async function getAllGeminiKeysWithUsage() {
    // Fetch models config and category quotas needed for display logic
    const [modelsConfig, categoryQuotas] = await Promise.all([
        configService.getModelsConfig(),
        configService.getCategoryQuotas()
    ]);

    const keys = await configService.allDb('SELECT * FROM gemini_keys ORDER BY created_at DESC');
    const todayInLA = getTodayInLA();

    return keys.map(keyRow => {
        try {
            const modelUsageDb = JSON.parse(keyRow.model_usage || '{}');
            const categoryUsageDb = JSON.parse(keyRow.category_usage || '{}');
            const consecutive429CountsDb = JSON.parse(keyRow.consecutive_429_counts || '{}');

            const isQuotaReset = keyRow.usage_date !== todayInLA;

            let displayModelUsage = {};
             // Populate modelUsageData for all relevant models (Custom or Pro/Flash with individualQuota)
            Object.entries(modelsConfig).forEach(([modelId, modelConfig]) => {
                let quota = undefined;
                let shouldInclude = false;

                if (modelConfig.category === 'Custom') {
                    quota = modelConfig.dailyQuota;
                    shouldInclude = true; // Always include Custom models
                } else if ((modelConfig.category === 'Pro' || modelConfig.category === 'Flash') && modelConfig.individualQuota) {
                    quota = modelConfig.individualQuota;
                    shouldInclude = true; // Include Pro/Flash if they have individualQuota
                }

                if (shouldInclude) {
                    const count = isQuotaReset ? 0 : (modelUsageDb[modelId] || 0);
                    displayModelUsage[modelId] = {
                        count: typeof count === 'number' ? count : 0, // Ensure count is a number
                        quota: quota
                    };
                }
            });


            const displayCategoryUsage = isQuotaReset
                ? { pro: 0, flash: 0 }
                : {
                    pro: categoryUsageDb.pro || 0,
                    flash: categoryUsageDb.flash || 0
                  };

            // Calculate overall usage for display (sum of category + custom model usage)
            // This is just for display, not used for actual quota checks
            let displayTotalUsage = 0;
            if (!isQuotaReset) {
                displayTotalUsage = (displayCategoryUsage.pro || 0) + (displayCategoryUsage.flash || 0);
                Object.values(displayModelUsage).forEach(usage => {
                    // Only add custom model usage if category is Custom
                    const modelId = Object.keys(displayModelUsage).find(key => displayModelUsage[key] === usage);
                    if (modelId && modelsConfig[modelId]?.category === 'Custom') {
                         displayTotalUsage += usage.count;
                    }
                });
            }


            return {
                id: keyRow.id,
                name: keyRow.name || keyRow.id,
                keyPreview: `...${(keyRow.api_key || '').slice(-4)}`,
                usage: displayTotalUsage, // Display calculated total usage
                usageDate: keyRow.usage_date || 'N/A',
                modelUsage: displayModelUsage,
                categoryUsage: displayCategoryUsage,
                categoryQuotas: categoryQuotas, // Pass fetched quotas for context
                errorStatus: keyRow.error_status, // 401, 403, or null
                consecutive429Counts: consecutive429CountsDb || {}
            };
        } catch (e) {
            console.error(`Error processing key ${keyRow.id}:`, e);
            return null; // Skip malformed keys
        }
    }).filter(k => k !== null);
}

/**
 * Retrieves keys currently marked with an error status (401 or 403).
 * @returns {Promise<Array<{id: string, name: string, error: number}>>}
 */
async function getErrorKeys() {
    const rows = await configService.allDb('SELECT id, name, error_status FROM gemini_keys WHERE error_status = 401 OR error_status = 403');
    return rows.map(row => ({
        id: row.id,
        name: row.name || row.id,
        error: row.error_status,
    }));
}

/**
 * Clears the error status (sets to NULL) for a specific key.
 * @param {string} keyId The ID of the key to clear the error for.
 * @returns {Promise<void>}
 */
async function clearKeyError(keyId) {
     const result = await configService.runDb('UPDATE gemini_keys SET error_status = NULL WHERE id = ?', [keyId]);
     if (result.changes === 0) {
         throw new Error(`Key with ID '${keyId}' not found for clearing error status.`);
     }
     console.log(`Cleared error status for key ${keyId}.`);
}

/**
 * Records a persistent error (401/403) for a key.
 * @param {string} keyId
 * @param {401 | 403} status
 * @returns {Promise<void>}
 */
async function recordKeyError(keyId, status) {
    if (status !== 401 && status !== 403) {
        console.warn(`Attempted to record invalid error status ${status} for key ${keyId}.`);
        return;
    }
    try {
        const result = await configService.runDb(
            'UPDATE gemini_keys SET error_status = ? WHERE id = ?',
            [status, keyId]
        );
         if (result.changes > 0) {
            console.log(`Recorded error status ${status} for key ${keyId}.`);
         } else {
             console.warn(`Cannot record error: Key info not found for ID: ${keyId}`);
         }
    } catch (e) {
        console.error(`Failed to record error status ${status} for key ${keyId}:`, e);
        // Don't rethrow, recording error is secondary
    }
}

// --- Key Selection and Usage Update Logic ---

/**
 * Selects the next available Gemini API key using round-robin.
 * Skips keys with errors or quota limits reached.
 * @param {string} [requestedModelId] The model being requested, for quota checking.
 * @returns {Promise<{ id: string; key: string } | null>} The selected key ID and value, or null if none available.
 */
async function getNextAvailableGeminiKey(requestedModelId) {
    try {
        // 1. Get key list, current index, configs in parallel
        const [allKeyIds, currentIndexSetting, modelsConfig, categoryQuotas] = await Promise.all([
            configService.getSetting('gemini_key_list', []),
            configService.getSetting('gemini_key_index', 0),
            configService.getModelsConfig(),
            configService.getCategoryQuotas()
        ]);

         if (!Array.isArray(allKeyIds) || allKeyIds.length === 0) {
            console.error("No Gemini keys configured in settings 'gemini_key_list'");
            return null;
        }

        let currentIndex = (typeof currentIndexSetting === 'number' && currentIndexSetting >= 0) ? currentIndexSetting : 0;
        if (currentIndex >= allKeyIds.length) {
            currentIndex = 0; // Reset if index is out of bounds
        }

        // 2. Determine model category for quota checks
        let modelCategory = undefined;
        let modelConfig = undefined;
        if (requestedModelId) {
            modelConfig = modelsConfig[requestedModelId];
            if (modelConfig) {
                 modelCategory = modelConfig.category;
            } else {
                console.warn(`Model ID '${requestedModelId}' not found in config during key selection.`);
                // Proceed without model-specific quota checks if model unknown
            }
        }

        // 3. Iterate through keys using round-robin
        const todayInLA = getTodayInLA();
        let selectedKeyData = null;
        let keysChecked = 0;
        let initialIndex = currentIndex; // To detect full loop

        while (keysChecked < allKeyIds.length) {
            const keyId = allKeyIds[currentIndex];
            keysChecked++;

            const keyInfo = await configService.getDb('SELECT * FROM gemini_keys WHERE id = ?', [keyId]);

            // --- Move index update here to ensure it always happens ---
            const nextIndex = (currentIndex + 1) % allKeyIds.length;


            // --- Validation Checks ---
            if (!keyInfo) {
                console.warn(`Key ID ${keyId} from list not found in database. Skipping.`);
                 currentIndex = nextIndex;
                continue; // Skip this key if its details aren't in the DB
            }

            // Check for 401/403 error status
            if (keyInfo.error_status === 401 || keyInfo.error_status === 403) {
                console.log(`Skipping key ${keyId} due to error status: ${keyInfo.error_status}`);
                 currentIndex = nextIndex;
                continue;
            }

            // Check quota if model category is known and it's the same day
            let quotaExceeded = false;
            if (modelCategory && keyInfo.usage_date === todayInLA) {
                 try {
                    const modelUsage = JSON.parse(keyInfo.model_usage || '{}');
                    const categoryUsage = JSON.parse(keyInfo.category_usage || '{}');

                    switch (modelCategory) {
                        case 'Pro':
                            if (modelConfig?.individualQuota) { // Check individual first
                                if ((modelUsage[requestedModelId] || 0) >= modelConfig.individualQuota) {
                                    console.log(`Skipping key ${keyId}: Pro model '${requestedModelId}' individual quota reached (${modelUsage[requestedModelId] || 0}/${modelConfig.individualQuota}).`);
                                    quotaExceeded = true;
                                }
                            }
                            if (!quotaExceeded && categoryQuotas.proQuota !== null && (categoryUsage.pro || 0) >= categoryQuotas.proQuota) {
                                console.log(`Skipping key ${keyId}: Pro category quota reached (${categoryUsage.pro || 0}/${categoryQuotas.proQuota}).`);
                                quotaExceeded = true;
                            }
                            break;
                        case 'Flash':
                             if (modelConfig?.individualQuota) { // Check individual first
                                if ((modelUsage[requestedModelId] || 0) >= modelConfig.individualQuota) {
                                    console.log(`Skipping key ${keyId}: Flash model '${requestedModelId}' individual quota reached (${modelUsage[requestedModelId] || 0}/${modelConfig.individualQuota}).`);
                                    quotaExceeded = true;
                                }
                            }
                            if (!quotaExceeded && categoryQuotas.flashQuota !== null && (categoryUsage.flash || 0) >= categoryQuotas.flashQuota) {
                                console.log(`Skipping key ${keyId}: Flash category quota reached (${categoryUsage.flash || 0}/${categoryQuotas.flashQuota}).`);
                                quotaExceeded = true;
                            }
                            break;
                        case 'Custom':
                            if (modelConfig?.dailyQuota !== null && (modelUsage[requestedModelId] || 0) >= modelConfig.dailyQuota) {
                                console.log(`Skipping key ${keyId}: Custom model '${requestedModelId}' quota reached (${modelUsage[requestedModelId] || 0}/${modelConfig.dailyQuota}).`);
                                quotaExceeded = true;
                            }
                            break;
                    }
                 } catch (parseError) {
                     console.error(`Error parsing usage JSON for key ${keyId}. Skipping quota check. Error:`, parseError);
                     // Optionally skip the key entirely if parsing fails
                 }
            }

            if (quotaExceeded) {
                 currentIndex = nextIndex;
                continue; // Skip this key
            }

            // If we reach here, the key is valid
            selectedKeyData = { id: keyInfo.id, key: keyInfo.api_key };
             currentIndex = nextIndex; // Set index for the *next* request
            break; // Found a valid key
        } // End while loop

        // --- Post-selection Updates ---
        if (!selectedKeyData) {
            console.error("No available Gemini keys found after checking all keys.");
            return null;
        }

        // Save the next index for the subsequent request
        // Use Promise.allSettled to avoid unhandled rejections if settings update fails
        await Promise.allSettled([
             configService.setSetting('gemini_key_index', currentIndex),
             configService.setSetting('last_used_gemini_key_id', selectedKeyData.id)
        ]);


        console.log(`Selected Gemini Key ID via sequential round-robin: ${selectedKeyData.id} (next index will be: ${currentIndex})`);
        return selectedKeyData;

    } catch (error) {
        console.error("Error retrieving or processing Gemini keys:", error);
        return null;
    }
}


/**
 * Increments the usage count for a given Gemini Key ID. Resets if the date changes.
 * Tracks usage per model and per category. Resets 429 counters on success.
 * @param {string} keyId
 * @param {string} [modelId]
 * @param {'Pro' | 'Flash' | 'Custom'} [category]
 * @returns {Promise<void>}
 */
async function incrementKeyUsage(keyId, modelId, category) {
    const keyRow = await configService.getDb('SELECT usage_date, model_usage, category_usage, consecutive_429_counts FROM gemini_keys WHERE id = ?', [keyId]);
    if (!keyRow) {
        console.warn(`Cannot increment usage: Key info not found for ID: ${keyId}`);
        return;
    }

    try {
        const todayInLA = getTodayInLA();
        let modelUsage = JSON.parse(keyRow.model_usage || '{}');
        let categoryUsage = JSON.parse(keyRow.category_usage || '{}');
        let consecutive429Counts = {}; // Reset 429 on successful usage increment
        let usageDate = keyRow.usage_date;

        // Reset counters if it's a new day
        if (usageDate !== todayInLA) {
            console.log(`Date change detected for key ${keyId} (${usageDate} → ${todayInLA}). Resetting usage.`);
            usageDate = todayInLA;
            modelUsage = {};
            categoryUsage = { pro: 0, flash: 0 };
            // 429 counts are already reset above
        }

        // Increment model-specific usage
        if (modelId) {
            modelUsage[modelId] = (modelUsage[modelId] || 0) + 1;
        }

        // Increment category-specific usage
        if (category === 'Pro') {
            categoryUsage.pro = (categoryUsage.pro || 0) + 1;
        } else if (category === 'Flash') {
            categoryUsage.flash = (categoryUsage.flash || 0) + 1;
        }

        // Update the database
        const sql = `
            UPDATE gemini_keys
            SET usage_date = ?, model_usage = ?, category_usage = ?, consecutive_429_counts = ?
            WHERE id = ?
        `;
        await configService.runDb(sql, [
            usageDate,
            JSON.stringify(modelUsage),
            JSON.stringify(categoryUsage),
            JSON.stringify(consecutive429Counts), // Store empty object (reset counters)
            keyId
        ]);
         console.log(`Usage for key ${keyId} updated. Date: ${usageDate}, Model: ${modelId} (${category}), Models: ${JSON.stringify(modelUsage)}, Categories: ${JSON.stringify(categoryUsage)}, 429Counts reset.`);

    } catch (e) {
        console.error(`Failed to increment usage for key ${keyId}:`, e);
        // Don't rethrow, allow request to potentially succeed anyway
    }
}

/**
 * Forces the usage count for a specific category/model on a key to its configured limit.
 * Resets the specific 429 counter that triggered the limit.
 * @param {string} keyId
 * @param {'Pro' | 'Flash' | 'Custom'} category
 * @param {string} [modelId] Optional model ID (required for Custom or Pro/Flash with individual quota).
 * @param {string} [counterKey] The specific counter key (e.g., 'model-id' or 'category:pro') to reset.
 * @returns {Promise<void>}
 */
async function forceSetQuotaToLimit(keyId, category, modelId, counterKey) {
     try {
        // Fetch current key info and configs
        const [keyRow, modelsConfig, categoryQuotas] = await Promise.all([
            configService.getDb('SELECT usage_date, model_usage, category_usage, consecutive_429_counts FROM gemini_keys WHERE id = ?', [keyId]),
             configService.getModelsConfig(),
             configService.getCategoryQuotas()
        ]);

        if (!keyRow) {
            console.warn(`Cannot force quota limit: Key info not found for ID: ${keyId}`);
            return;
        }

        const todayInLA = getTodayInLA();
        let modelUsage = JSON.parse(keyRow.model_usage || '{}');
        let categoryUsage = JSON.parse(keyRow.category_usage || '{}');
        let consecutive429Counts = JSON.parse(keyRow.consecutive_429_counts || '{}');
        let usageDate = keyRow.usage_date;

        // Reset usage if date changed
        if (usageDate !== todayInLA) {
            console.log(`Date change detected in forceSetQuotaToLimit for key ${keyId}. Resetting usage before forcing.`);
            usageDate = todayInLA;
            modelUsage = {};
            categoryUsage = { pro: 0, flash: 0 };
            consecutive429Counts = {}; // Also reset 429 counts on date change
        }

         // Reset the specific 429 counter
         if (counterKey && consecutive429Counts.hasOwnProperty(counterKey)) {
             console.log(`Resetting 429 counter for key ${keyId}, counter ${counterKey} after forcing quota.`);
             delete consecutive429Counts[counterKey];
         }

        // Determine the limit and update the relevant usage counter
        let quotaLimit = Infinity;
        const modelConfig = modelId ? modelsConfig[modelId] : undefined;
        let updated = false;

        switch (category) {
            case 'Pro':
                if (modelId && modelConfig?.individualQuota) {
                    quotaLimit = modelConfig.individualQuota;
                    modelUsage[modelId] = quotaLimit;
                    console.log(`Forcing Pro model ${modelId} individual usage for key ${keyId} to limit: ${quotaLimit}`);
                    updated = true;
                } else if (categoryQuotas.proQuota !== null) {
                    quotaLimit = categoryQuotas.proQuota;
                    categoryUsage.pro = quotaLimit;
                    console.log(`Forcing Pro category usage for key ${keyId} to limit: ${quotaLimit}`);
                    updated = true;
                }
                break;
            case 'Flash':
                 if (modelId && modelConfig?.individualQuota) {
                    quotaLimit = modelConfig.individualQuota;
                    modelUsage[modelId] = quotaLimit;
                    console.log(`Forcing Flash model ${modelId} individual usage for key ${keyId} to limit: ${quotaLimit}`);
                    updated = true;
                } else if (categoryQuotas.flashQuota !== null) {
                    quotaLimit = categoryQuotas.flashQuota;
                    categoryUsage.flash = quotaLimit;
                     console.log(`Forcing Flash category usage for key ${keyId} to limit: ${quotaLimit}`);
                     updated = true;
                }
                break;
            case 'Custom':
                if (modelId && modelConfig?.dailyQuota !== null) {
                    quotaLimit = modelConfig.dailyQuota;
                    modelUsage[modelId] = quotaLimit;
                    console.log(`Forcing Custom model ${modelId} usage for key ${keyId} to limit: ${quotaLimit}`);
                    updated = true;
                } else if (!modelId) {
                     console.warn(`Cannot force quota limit for Custom category without modelId.`);
                }
                break;
        }

        if (!updated) {
             console.warn(`No relevant quota found to force for key ${keyId}, category ${category}, model ${modelId}.`);
             // Still save potential reset of 429 counter if counterKey was provided
             if (counterKey) {
                  await configService.runDb(
                    'UPDATE gemini_keys SET consecutive_429_counts = ? WHERE id = ?',
                    [JSON.stringify(consecutive429Counts), keyId]
                 );
             }
             return;
        }

        // Update the database
        const sql = `
            UPDATE gemini_keys
            SET usage_date = ?, model_usage = ?, category_usage = ?, consecutive_429_counts = ?
            WHERE id = ?
        `;
         await configService.runDb(sql, [
            usageDate,
            JSON.stringify(modelUsage),
            JSON.stringify(categoryUsage),
            JSON.stringify(consecutive429Counts),
            keyId
         ]);
         console.log(`Key ${keyId} quota forced for category ${category}${modelId ? ` (model: ${modelId})` : ''} for date ${usageDate}.`);

     } catch (e) {
         console.error(`Failed to force quota limit for key ${keyId}:`, e);
     }
}

/**
 * Handles 429 errors: increments counter, forces quota limit if threshold reached.
 * @param {string} keyId
 * @param {'Pro' | 'Flash' | 'Custom'} category
 * @param {string} [modelId] Optional model ID.
 * @returns {Promise<void>}
 */
async function handle429Error(keyId, category, modelId) {
    const CONSECUTIVE_429_LIMIT = 3;

    try {
         const [keyRow, modelsConfig, categoryQuotas] = await Promise.all([
            configService.getDb('SELECT consecutive_429_counts FROM gemini_keys WHERE id = ?', [keyId]),
            configService.getModelsConfig(),
            configService.getCategoryQuotas()
        ]);

        if (!keyRow) {
            console.warn(`Cannot handle 429: Key info not found for ID: ${keyId}`);
            return;
        }

        let consecutive429Counts = JSON.parse(keyRow.consecutive_429_counts || '{}');

        // Determine the counter key and if a relevant quota exists
        let counterKey = undefined;
        let needsQuotaCheck = false;
        const modelConfig = modelId ? modelsConfig[modelId] : undefined;

         if (category === 'Custom' && modelId) {
            counterKey = modelId;
            needsQuotaCheck = !!modelConfig?.dailyQuota;
        } else if ((category === 'Pro' || category === 'Flash') && modelId && modelConfig?.individualQuota) {
            counterKey = modelId;
            needsQuotaCheck = true;
        } else if (category === 'Pro') {
            counterKey = 'category:pro';
            needsQuotaCheck = !!categoryQuotas?.proQuota && isFinite(categoryQuotas.proQuota);
        } else if (category === 'Flash') {
            counterKey = 'category:flash';
            needsQuotaCheck = !!categoryQuotas?.flashQuota && isFinite(categoryQuotas.flashQuota);
        }

        if (!counterKey) {
            console.warn(`Could not determine counter key for 429 handling (key ${keyId}, category ${category}, model ${modelId}).`);
            return;
        }
        if (!needsQuotaCheck) {
            console.log(`Skipping 429 counter for key ${keyId}, counter ${counterKey} as no relevant quota is configured.`);
            return;
        }

        // Increment counter
        const currentCount = (consecutive429Counts[counterKey] || 0) + 1;
        consecutive429Counts[counterKey] = currentCount;

        console.warn(`Received 429 for key ${keyId}, counter ${counterKey}. Consecutive count: ${currentCount}`);

        // Check limit and force quota if reached
        if (currentCount >= CONSECUTIVE_429_LIMIT) {
            console.warn(`Consecutive 429 limit (${CONSECUTIVE_429_LIMIT}) reached for key ${keyId}, counter ${counterKey}. Forcing quota limit.`);
            // forceSetQuotaToLimit will reset the counterKey within consecutive429Counts
            await forceSetQuotaToLimit(keyId, category, modelId, counterKey);
            // No need to save consecutive429Counts separately here, forceSet does it.
        } else {
            // Limit not reached, just save the updated count
             await configService.runDb(
                'UPDATE gemini_keys SET consecutive_429_counts = ? WHERE id = ?',
                [JSON.stringify(consecutive429Counts), keyId]
             );
        }

    } catch (e) {
        console.error(`Failed to handle 429 error for key ${keyId}:`, e);
    }
}


module.exports = {
    addGeminiKey,
    deleteGeminiKey,
    getAllGeminiKeysWithUsage,
    getNextAvailableGeminiKey,
    incrementKeyUsage,
    handle429Error,
    // forceSetQuotaToLimit, // Internal helper, not typically exported
    recordKeyError,
    getErrorKeys,
    clearKeyError,
};
