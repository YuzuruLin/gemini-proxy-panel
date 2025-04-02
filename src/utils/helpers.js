/**
 * Helper function to get today's date in Los Angeles timezone (YYYY-MM-DD format)
 * Uses a more reliable method for timezone conversion
 */
function getTodayInLA() {
	// Get current date in Los Angeles timezone
	const date = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
	// Parse the date string into a Date object
	const laDate = new Date(date);
	// Format as YYYY-MM-DD
	return laDate.getFullYear() + '-' +
		String(laDate.getMonth() + 1).padStart(2, '0') + '-' +
		String(laDate.getDate()).padStart(2, '0');
}

/**
 * Helper to parse JSON body safely from Express request.
 * Note: Express middleware (express.json()) usually handles this,
 * but this can be a fallback or used if middleware isn't applied globally.
 * @param {Request} req - Express request object
 * @returns {Promise<object|null>} - Parsed body or null on error
 */
async function readRequestBody(req) {
    // Express's body-parser middleware (express.json()) already parses the body
    // and attaches it to req.body. We can directly return it.
    // Add a check in case the middleware wasn't used or failed.
    if (req.body) {
        return req.body;
    }
    // Fallback if req.body is not populated (e.g., middleware issue or raw request)
    // This part is less likely needed with standard Express setup but kept for robustness.
    try {
        // Manually read and parse if needed (requires different setup, typically not necessary)
        // For standard Express, this block might not execute if express.json() is used correctly.
        console.warn("req.body not populated, attempting manual parse (may indicate middleware issue)");
        // Example of manual parsing (would need raw body stream):
        // const buffer = await req.read(); // Hypothetical method
        // return JSON.parse(buffer.toString());
        return null; // Return null if req.body is missing
    } catch (e) {
        console.error("Error reading request body:", e);
        return null;
    }
}


// --- CORS Helper (for reference, but handled by 'cors' middleware in server.js) ---
// function corsHeaders() {
// 	return {
// 		'Access-Control-Allow-Origin': '*',
// 		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
// 		'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-requested-with',
// 		'Access-Control-Max-Age': '86400',
// 	};
// }

module.exports = {
    getTodayInLA,
    readRequestBody,
    // corsHeaders // Not exporting as it's handled by middleware
};
