const crypto = require('crypto');

const SESSION_COOKIE_NAME = '__session';
const SESSION_DURATION_SECONDS = 1 * 60 * 60; // 1 hour

// Use environment variables for secrets
const SESSION_SECRET_KEY = process.env.SESSION_SECRET_KEY;

if (!SESSION_SECRET_KEY) {
    console.error("FATAL: SESSION_SECRET_KEY environment variable is not set. Session management disabled.");
    // In a real app, you might throw an error or exit
}

/**
 * Converts Buffer to Base64 URL safe string.
 * @param {Buffer} buffer
 * @returns {string}
 */
function bufferToBase64Url(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Converts Base64 URL safe string to Buffer.
 * @param {string} base64url
 * @returns {Buffer}
 */
function base64UrlToBuffer(base64url) {
    base64url = base64url.replace(/-/g, '+').replace(/_/g, '/');
    // Padding is handled automatically by Buffer.from in newer Node versions
    return Buffer.from(base64url, 'base64');
}

/**
 * Generates a signed session token.
 * Payload: { exp: number }
 * @returns {Promise<string|null>} Session token or null on error.
 */
async function generateSessionToken() {
    if (!SESSION_SECRET_KEY) {
        console.error("Cannot generate session token: SESSION_SECRET_KEY is not set.");
        return null;
    }
    try {
        const expiration = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
        const payload = JSON.stringify({ exp: expiration });
        const encodedPayload = bufferToBase64Url(Buffer.from(payload));

        // Use Node.js crypto for HMAC
        const hmac = crypto.createHmac('sha256', SESSION_SECRET_KEY);
        hmac.update(encodedPayload);
        const signature = hmac.digest(); // Returns a Buffer
        const encodedSignature = bufferToBase64Url(signature);

        return `${encodedPayload}.${encodedSignature}`;
    } catch (e) {
        console.error("Error generating session token:", e);
        return null;
    }
}

/**
 * Verifies the signature and expiration of a session token.
 * @param {string} token - The session token string.
 * @returns {Promise<boolean>} True if valid and not expired, false otherwise.
 */
async function verifySessionToken(token) {
    if (!SESSION_SECRET_KEY || !token) {
        // console.error("Cannot verify session token: SESSION_SECRET_KEY or token missing.");
        return false;
    }
    try {
        const parts = token.split('.');
        if (parts.length !== 2) return false;

        const [encodedPayload, encodedSignature] = parts;
        const signatureBuffer = base64UrlToBuffer(encodedSignature);

        // Recalculate HMAC signature for comparison
        const hmac = crypto.createHmac('sha256', SESSION_SECRET_KEY);
        hmac.update(encodedPayload);
        const expectedSignatureBuffer = hmac.digest();

        // Compare signatures using timing-safe comparison
        if (!crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
            console.warn("Session token signature mismatch.");
            return false;
        }

        // Decode payload and check expiration
        const payloadJson = base64UrlToBuffer(encodedPayload).toString();
        const payload = JSON.parse(payloadJson);

        const now = Math.floor(Date.now() / 1000);
        if (payload.exp <= now) {
            console.log("Session token expired.");
            return false;
        }

        return true; // Token is valid and not expired

    } catch (e) {
        console.error("Error verifying session token:", e);
        return false;
    }
}

/**
 * Extracts the session token from the request's cookies.
 * Uses cookie-parser middleware result.
 * @param {import('express').Request} req - Express request object.
 * @returns {string | null} The session token or null.
 */
function getSessionTokenFromCookie(req) {
    // cookie-parser middleware populates req.cookies
    return req.cookies?.[SESSION_COOKIE_NAME] || null;
}

/**
 * Sets the session cookie on the response.
 * @param {import('express').Response} res - Express response object.
 * @param {string} token - The session token.
 */
function setSessionCookie(res, token) {
    const expires = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);
    res.cookie(SESSION_COOKIE_NAME, token, {
        path: '/',
        expires: expires,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        sameSite: 'Lax' // Protects against CSRF to some extent
    });
}

/**
 * Clears the session cookie on the response.
 * @param {import('express').Response} res - Express response object.
 */
function clearSessionCookie(res) {
    res.cookie(SESSION_COOKIE_NAME, '', {
        path: '/',
        expires: new Date(0), // Set expiry date to the past
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax'
    });
}

/**
 * Verifies the session cookie from the request.
 * @param {import('express').Request} req - Express request object.
 * @returns {Promise<boolean>} True if the session is valid.
 */
async function verifySessionCookie(req) {
    const token = getSessionTokenFromCookie(req);
    if (!token) {
        return false;
    }
    return await verifySessionToken(token);
}

module.exports = {
    generateSessionToken,
    verifySessionToken,
    getSessionTokenFromCookie,
    setSessionCookie,
    clearSessionCookie,
    verifySessionCookie,
    SESSION_COOKIE_NAME,
};
