const db = require('../db');

// --- Helper Functions for DB Interaction ---

/**
 * Helper function to run a single SQL query with parameters.
 * Returns a Promise.
 * @param {string} sql The SQL query string.
 * @param {Array} params Query parameters.
 * @returns {Promise<object>} Promise resolving with { lastID, changes } or rejecting with error.
 */
const runDb = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { // Use function() to access this context
            if (err) {
                console.error('Database run error:', err.message, 'SQL:', sql, 'Params:', params);
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
};

/**
 * Helper function to get a single row from the database.
 * Returns a Promise.
 * @param {string} sql The SQL query string.
 * @param {Array} params Query parameters.
 * @returns {Promise<object|null>} Promise resolving with the row or null, or rejecting with error.
 */
const getDb = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                console.error('Database get error:', err.message, 'SQL:', sql, 'Params:', params);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
};

/**
 * Helper function to get all rows from the database.
 * Returns a Promise.
 * @param {string} sql The SQL query string.
 * @param {Array} params Query parameters.
 * @returns {Promise<Array>} Promise resolving with an array of rows or rejecting with error.
 */
const allDb = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('Database all error:', err.message, 'SQL:', sql, 'Params:', params);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
};


// --- Settings Management (Generic Key-Value) ---

/**
 * Gets a specific setting value from the 'settings' table.
 * @param {string} key The setting key.
 * @param {any} [defaultValue=null] Value to return if key not found.
 * @returns {Promise<any>} The setting value (parsed if JSON) or defaultValue.
 */
async function getSetting(key, defaultValue = null) {
    const row = await getDb('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row) {
        return defaultValue;
    }
    try {
        // Attempt to parse as JSON, fallback to raw value
        return JSON.parse(row.value);
    } catch (e) {
        return row.value; // Return as string if not valid JSON
    }
}

/**
 * Sets a specific setting value in the 'settings' table.
 * Automatically stringifies objects/arrays.
 * @param {string} key The setting key.
 * @param {any} value The value to set.
 * @returns {Promise<void>}
 */
async function setSetting(key, value) {
    const valueToStore = (typeof value === 'object' && value !== null)
        ? JSON.stringify(value)
        : String(value); // Ensure it's a string if not object/array
    await runDb('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, valueToStore]);
}


// --- Model Configuration ---

/**
 * Gets the entire models configuration object.
 * @returns {Promise<Record<string, {category: string, dailyQuota?: number, individualQuota?: number}>>}
 */
async function getModelsConfig() {
    const rows = await allDb('SELECT * FROM models_config');
    const config = {};
    rows.forEach(row => {
        config[row.model_id] = {
            category: row.category,
            // Return null or undefined from DB as undefined
            dailyQuota: row.daily_quota ?? undefined,
            individualQuota: row.individual_quota ?? undefined
        };
    });
    return config;
}

/**
 * Adds or updates a model configuration.
 * @param {string} modelId
 * @param {'Pro' | 'Flash' | 'Custom'} category
 * @param {number | null | undefined} dailyQuota Use null/undefined for no limit.
 * @param {number | null | undefined} individualQuota Use null/undefined for no limit.
 * @returns {Promise<void>}
 */
async function setModelConfig(modelId, category, dailyQuota, individualQuota) {
    const sql = `
        INSERT OR REPLACE INTO models_config
        (model_id, category, daily_quota, individual_quota)
        VALUES (?, ?, ?, ?)
    `;
    // Ensure null is stored in DB if quota is undefined or explicitly null
    const dailyQuotaDb = (dailyQuota === undefined || dailyQuota === null) ? null : Number(dailyQuota);
    const individualQuotaDb = (individualQuota === undefined || individualQuota === null) ? null : Number(individualQuota);

    if ((category === 'Custom' && dailyQuotaDb !== null && !Number.isInteger(dailyQuotaDb)) || dailyQuotaDb < 0) {
        throw new Error("Custom model dailyQuota must be a non-negative integer or null.");
    }
     if (( (category === 'Pro' || category === 'Flash') && individualQuotaDb !== null && !Number.isInteger(individualQuotaDb)) || individualQuotaDb < 0) {
        throw new Error("Pro/Flash model individualQuota must be a non-negative integer or null.");
    }


    await runDb(sql, [modelId, category, dailyQuotaDb, individualQuotaDb]);
}

/**
 * Deletes a model configuration.
 * @param {string} modelId
 * @returns {Promise<void>}
 */
async function deleteModelConfig(modelId) {
    const result = await runDb('DELETE FROM models_config WHERE model_id = ?', [modelId]);
     if (result.changes === 0) {
        throw new Error(`Model '${modelId}' not found for deletion.`);
    }
}


// --- Category Quotas ---

/**
 * Gets the category quotas (Pro/Flash).
 * @returns {Promise<{proQuota: number, flashQuota: number}>}
 */
async function getCategoryQuotas() {
    // Retrieve from settings table, providing defaults
    const quotas = await getSetting('category_quotas', { proQuota: 50, flashQuota: 1500 });
    // Ensure the retrieved value has the expected format
     return {
        proQuota: typeof quotas?.proQuota === 'number' ? quotas.proQuota : 50,
        flashQuota: typeof quotas?.flashQuota === 'number' ? quotas.flashQuota : 1500,
    };
}

/**
 * Sets the category quotas.
 * @param {number} proQuota
 * @param {number} flashQuota
 * @returns {Promise<void>}
 */
async function setCategoryQuotas(proQuota, flashQuota) {
    if (typeof proQuota !== 'number' || typeof flashQuota !== 'number' || proQuota < 0 || flashQuota < 0) {
        throw new Error("Quotas must be non-negative numbers.");
    }
    await setSetting('category_quotas', {
        proQuota: Math.floor(proQuota),
        flashQuota: Math.floor(flashQuota)
    });
}


// --- Worker Keys ---

/**
 * Gets all worker keys with their descriptions and safety settings.
 * @returns {Promise<Array<{key: string, description: string, safetyEnabled: boolean, createdAt: string}>>}
 */
async function getAllWorkerKeys() {
    const rows = await allDb('SELECT api_key, description, safety_enabled, created_at FROM worker_keys ORDER BY created_at DESC');
    return rows.map(row => ({
        key: row.api_key,
        description: row.description || '',
        safetyEnabled: row.safety_enabled === 1, // Convert DB integer to boolean
        createdAt: row.created_at
    }));
}

/**
 * Gets safety setting for a specific worker key.
 * @param {string} apiKey The worker API key.
 * @returns {Promise<boolean>} True if safety is enabled, false otherwise (defaults to true if key not found, though middleware should prevent this).
 */
async function getWorkerKeySafetySetting(apiKey) {
     const row = await getDb('SELECT safety_enabled FROM worker_keys WHERE api_key = ?', [apiKey]);
     // Default to true if key doesn't exist (shouldn't happen if middleware is used) or if value is null/undefined
     return row ? row.safety_enabled === 1 : true;
}


/**
 * Adds a new worker key.
 * @param {string} apiKey
 * @param {string} [description='']
 * @returns {Promise<void>}
 */
async function addWorkerKey(apiKey, description = '') {
    const sql = `
        INSERT INTO worker_keys (api_key, description, safety_enabled, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `;
    try {
        await runDb(sql, [apiKey, description, 1]); // Default safety_enabled to true (1)
    } catch (err) {
         if (err.code === 'SQLITE_CONSTRAINT') { // Handle potential unique constraint violation
            throw new Error(`Worker key '${apiKey}' already exists.`);
        }
        throw err; // Re-throw other errors
    }
}

/**
 * Updates a worker key's safety setting.
 * @param {string} apiKey
 * @param {boolean} safetyEnabled
 * @returns {Promise<void>}
 */
async function updateWorkerKeySafety(apiKey, safetyEnabled) {
     const sql = `UPDATE worker_keys SET safety_enabled = ? WHERE api_key = ?`;
     const result = await runDb(sql, [safetyEnabled ? 1 : 0, apiKey]);
     if (result.changes === 0) {
         throw new Error(`Worker key '${apiKey}' not found for updating safety settings.`);
     }
}


/**
 * Deletes a worker key.
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
async function deleteWorkerKey(apiKey) {
    const result = await runDb('DELETE FROM worker_keys WHERE api_key = ?', [apiKey]);
    if (result.changes === 0) {
        throw new Error(`Worker key '${apiKey}' not found for deletion.`);
    }
}


module.exports = {
    // Settings
    getSetting,
    setSetting,
    // Models
    getModelsConfig,
    setModelConfig,
    deleteModelConfig,
    // Category Quotas
    getCategoryQuotas,
    setCategoryQuotas,
    // Worker Keys
    getAllWorkerKeys,
    getWorkerKeySafetySetting,
    addWorkerKey,
    updateWorkerKeySafety,
    deleteWorkerKey,
    // DB helpers (optional export if needed elsewhere)
    runDb,
    getDb,
    allDb,
};
