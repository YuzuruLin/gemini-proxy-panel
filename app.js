// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// Import the database connection (this will also trigger initialization)
const db = require('./src/db'); // Assuming db/index.js exports the db instance

// Import route handlers
const authRoutes = require('./src/routes/auth');
const adminApiRoutes = require('./src/routes/adminApi');
const apiV1Routes = require('./src/routes/apiV1');

// Import middleware
const requireAdminAuth = require('./src/middleware/adminAuth');

const app = express();
const port = process.env.PORT || 3000; // Default to 3000 if PORT not set

// --- Middleware ---

// Enable CORS for all origins (adjust for production if needed)
app.use(cors({
    origin: '*', // Allow all origins for now
    credentials: true, // Allow cookies for authenticated requests (like admin UI)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
    maxAge: 86400 // Cache preflight requests for 1 day
}));

// Handle OPTIONS preflight requests globally (alternative to handling in each route)
app.options('*', cors());

// Parse JSON request bodies
app.use(express.json({ limit: '100mb' }));

// Parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Parse cookies
app.use(cookieParser());

// Serve static files from the 'public' directory
// __dirname now refers to the project root directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Basic Routes ---

// Root route: Redirects to /admin/index.html if logged in, otherwise requireAdminAuth redirects to /login.html
app.get('/', requireAdminAuth, (req, res) => {
    // If we reach here, user is authenticated by requireAdminAuth
    res.redirect('/admin/index.html');
});

// Redirect /login to the static HTML file
app.get('/login', (req, res) => {
    res.redirect('/login.html');
});

// Admin route: Protect the route and serve the static file
app.get('/admin', requireAdminAuth, (req, res) => {
    res.redirect('/admin/'); // Redirect to the directory path
});

app.use('/admin', requireAdminAuth, express.static(path.join(__dirname, 'public', 'admin')));

// --- API Routes ---
app.use('/api', authRoutes); 
app.use('/api/admin', requireAdminAuth, adminApiRoutes); 
app.use('/v1', apiV1Routes); 

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack || err);
    res.status(err.status || 500).json({
        error: {
            message: err.message || 'Internal Server Error',
            type: err.type || 'unhandled_error',
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
        }
    });
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Gemini Proxy Panel (Node.js version) listening on port ${port}`);
    console.log(`Admin UI should be available at http://localhost:${port}/`);
});
