const express = require('express');
const { generateSessionToken, setSessionCookie, clearSessionCookie } = require('../utils/session');
const { readRequestBody } = require('../utils/helpers'); // Although body-parser is used, keep for consistency

const router = express.Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET_KEY = process.env.SESSION_SECRET_KEY;

if (!ADMIN_PASSWORD) {
    console.error("FATAL: ADMIN_PASSWORD environment variable is not set. Admin login disabled.");
}
if (!SESSION_SECRET_KEY) {
    // Error already logged in session.js, but good to be aware here too.
    console.error("FATAL: SESSION_SECRET_KEY environment variable is not set. Login will fail.");
}

// --- Login Route ---
// Path: /api/login (mounted under /api in server.js)
router.post('/login', async (req, res, next) => {
    if (!ADMIN_PASSWORD || !SESSION_SECRET_KEY) {
        return res.status(500).json({ error: 'Server configuration error: Credentials or session secret not set.' });
    }

    try {
        // express.json() middleware populates req.body
        const body = req.body;
        if (!body || typeof body.password !== 'string') {
            return res.status(400).json({ error: 'Password is required.' });
        }

        if (body.password === ADMIN_PASSWORD) {
            // Password matches, generate and set session token
            const token = await generateSessionToken();
            if (!token) {
                // Error already logged in generateSessionToken
                return res.status(500).json({ error: 'Failed to generate session token.' });
            }

            setSessionCookie(res, token); // Set the cookie on the response
            console.log('Admin login successful.');
            return res.status(200).json({ success: true });

        } else {
            // Invalid password
            console.warn('Admin login failed: Invalid password.');
            return res.status(401).json({ error: 'Invalid password.' });
        }
    } catch (error) {
        console.error("Error during login:", error);
        // Pass error to the global error handler
        next(error);
    }
});

// --- Logout Route ---
// Path: /api/logout (mounted under /api in server.js)
router.post('/logout', (req, res) => {
    try {
        clearSessionCookie(res); // Clear the cookie
        console.log('Admin logout successful.');
        // Send a simple success response. Client should handle redirect.
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error during logout:", error);
        // Pass error to the global error handler
        // Note: synchronous errors might not be caught by Express error handler unless passed explicitly
        next(error); // Ensure error is passed if any occurs unexpectedly
    }
});

module.exports = router;
