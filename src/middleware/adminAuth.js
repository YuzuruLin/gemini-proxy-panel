const { verifySessionCookie } = require('../utils/session');

/**
 * Express middleware to protect routes requiring admin authentication.
 * Verifies the session cookie. If invalid or missing, redirects to /login.html.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireAdminAuth(req, res, next) {
    try {
        const isAuthenticated = await verifySessionCookie(req);

        if (!isAuthenticated) {
            console.log('AdminAuth Middleware: Session invalid or expired. Redirecting to login.');
            // Redirect to the login page if not authenticated
            // Check if the original request was for an API endpoint
            if (req.originalUrl.startsWith('/api/admin')) {
                // For API requests, send a 401 Unauthorized status instead of redirecting
                return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
            } else {
                // For page requests (like /admin), redirect to the login page
                return res.redirect('/login.html');
            }
        }

        // If authenticated, proceed to the next middleware or route handler
        // console.log('AdminAuth Middleware: Session valid.'); // Optional: Log success
        next();
    } catch (error) {
        console.error('Error in admin authentication middleware:', error);
        // Pass the error to the global error handler
        next(error);
    }
}

module.exports = requireAdminAuth;
