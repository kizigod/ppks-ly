require('dotenv').config();
const QRCode = require('qrcode'); 
const express = require('express');
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const passport = require('passport');
const path = require('path');

// IMPORT MODEL
const Url = require('./models/Url');
const User = require('./models/User'); 

const app = express();

// --- MODEL VISITOR ---
const Visitor = mongoose.models.Visitor || mongoose.model('Visitor', new mongoose.Schema({
    ip: String,
    timestamp: { type: Date, default: Date.now }
}));

// --- 1. KONEKSI DATABASE ---
const connectDB = async () => {
    if (mongoose.connection.readyState >= 1) return;
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Terhubung ke MongoDB');
    } catch (err) {
        console.error('❌ MongoDB Error:', err);
    }
};
connectDB();

// --- 2. MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// KONFIGURASI SESSION (Disesuaikan agar tidak logout di localhost)
app.use(session({
    secret: process.env.SESSION_SECRET || 'sawit-rahasia-usu',
    resave: false,
    saveUninitialized: false,
    proxy: true, 
    cookie: { 
        // Secure true hanya jika di produksi (HTTPS)
        secure: process.env.NODE_ENV === 'production', 
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- 3. GOOGLE OAUTH STRATEGY ---
const OFFICIAL_DOMAIN = process.env.NODE_ENV === 'production' 
    ? "https://ppks-ly.vercel.app" 
    : "http://localhost:3000";

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${OFFICIAL_DOMAIN}/auth/google/callback`,
    proxy: true
}, async (accessToken, refreshToken, profile, done) => {
    try {
        await connectDB();
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
            user = await User.create({
                googleId: profile.id,
                displayName: profile.displayName,
                email: profile.emails[0].value,
                image: profile.photos[0].value
            });
        }
        return done(null, user);
    } catch (err) { 
        return done(err, null); 
    }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        await connectDB();
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// --- 4. ROUTES ---

// Route Visitor Tracking & Stats
app.get('/api/visitor/track', async (req, res) => {
    try {
        await connectDB();
        const newVisitor = new Visitor({ 
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress 
        });
        await newVisitor.save();
        
        const count = await Visitor.countDocuments();
        const totalClicksResult = await Url.aggregate([{ $group: { _id: null, total: { $sum: "$clicks" } } }]);
        const totalClicks = totalClicksResult.length > 0 ? totalClicksResult[0].total : 0;
        
        res.json({ totalVisitors: count, totalClicks: totalClicks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard.html')
);
app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

app.get('/api/user/status', (req, res) => {
    res.json(req.isAuthenticated() ? { loggedIn: true, user: req.user } : { loggedIn: false });
});

app.get('/api/user/links', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Harus login' });
    try {
        await connectDB();
        const links = await Url.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.json(links);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/link/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Harus login' });
    try {
        await connectDB();
        await Url.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        res.json({ message: 'Link dihapus' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// CREATE SHORTLINK
app.post('/api/shorten', async (req, res) => {
    const { longUrl, customCode } = req.body;
    const shortCode = (customCode && customCode.trim()) || nanoid(6);
    try {
        await connectDB();
        const existing = await Url.findOne({ shortCode });
        if (existing) return res.status(400).json({ message: 'Nama/Code sudah dipakai!' });

        const newUrl = new Url({ 
            originalUrl: longUrl, 
            shortCode,
            userId: req.isAuthenticated() ? req.user._id : null 
        });
        await newUrl.save();

        const shortUrl = `${OFFICIAL_DOMAIN}/${shortCode}`;
        const qrData = await QRCode.toDataURL(shortUrl);
        
        // PENTING: Mengirim data lengkap termasuk shortCode untuk Barcode di frontend
        res.json({ shortUrl, qrData, shortCode }); 
    } catch (err) {
        res.status(500).json({ message: 'Gagal memproses link', error: err.message });
    }
});

// REDIRECT ROUTE
app.get('/:code', async (req, res) => {
    const { code } = req.params;
    // Hindari redirect jika code adalah file atau rute API
    if (code.includes('.') || ['api', 'auth', 'favicon.ico', 'dashboard.html'].includes(code)) return;
    
    try {
        await connectDB();
        const url = await Url.findOne({ shortCode: code });
        if (url) {
            await Url.updateOne({ _id: url._id }, { $inc: { clicks: 1 } });
            return res.redirect(url.originalUrl);
        }
        res.status(404).send('<h1>404</h1><p>Link tidak ditemukan.</p>');
    } catch (err) {
        res.status(500).send(`Server Error: ${err.message}`);
    }
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log(`Server jalan di http://localhost:3000`));
}