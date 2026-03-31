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

// 1. KONEKSI DATABASE (Fungsi Reusable untuk Serverless)
const connectDB = async () => {
    if (mongoose.connection.readyState >= 1) return;
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Terhubung ke MongoDB');
    } catch (err) {
        console.error('❌ MongoDB Error:', err);
    }
};

// Jalankan koneksi di awal
connectDB();

// 2. MIDDLEWARE DASAR
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 3. MIDDLEWARE SESSION
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-ppks-ly',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// 4. MIDDLEWARE PASSPORT
app.use(passport.initialize());
app.use(passport.session());

// 5. STRATEGY GOOGLE (Kunci Callback agar tidak Mismatch)
const callbackURL = process.env.NODE_ENV === 'production' 
    ? `https://ppks-ly.vercel.app/auth/google/callback` 
    : "http://localhost:3000/auth/google/callback";

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: callbackURL,
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
        console.error("Error di Strategy:", err);
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

// --- ROUTES ---

// Halaman Utama
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cek Status Login
app.get('/api/user/status', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ loggedIn: true, user: req.user });
    } else {
        res.json({ loggedIn: false });
    }
});

// Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/dashboard.html'); }
);

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// Ambil Link User
app.get('/api/user/links', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Login dulu' });
    try {
        await connectDB();
        const links = await Url.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.json(links);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Buat Link Baru
app.post('/api/shorten', async (req, res) => {
    const { longUrl, customCode } = req.body;
    const shortCode = (customCode && customCode.trim()) || nanoid(6);

    try {
        await connectDB();
        let existing = await Url.findOne({ shortCode });
        if (existing) return res.status(400).json({ message: 'Nama sudah dipakai!' });

        const newUrl = new Url({ 
            originalUrl: longUrl, 
            shortCode,
            userId: req.isAuthenticated() ? req.user._id : null 
        });
        await newUrl.save();

        // Pastikan BASE_URL tidak punya double slash
        const cleanBaseUrl = process.env.BASE_URL.replace(/\/$/, "");
        const shortUrl = `${cleanBaseUrl}/${shortCode}`;
        const qrCodeData = await QRCode.toDataURL(shortUrl);

        res.json({ shortUrl, qrData: qrCodeData });
    } catch (err) {
        res.status(500).json({ message: 'Gagal memproses data', error: err.message });
    }
});

// REDIRECT ROUTE (Sangat Penting!)
app.get('/:code', async (req, res) => {
    const { code } = req.params;

    // Abaikan permintaan file statis agar tidak tabrakan
    if (code.includes('.') || code === 'api' || code === 'auth') return;

    try {
        await connectDB();
        const url = await Url.findOne({ shortCode: code });
        
        if (url) {
            // Update klik secara atomik
            await Url.updateOne({ _id: url._id }, { $inc: { clicks: 1 } });
            return res.redirect(url.originalUrl);
        }
        
        return res.status(404).send('<h1>404</h1><p>Link tidak ditemukan.</p>');
    } catch (err) {
        console.error('Redirect Error:', err);
        res.status(500).send("Server Error saat mencoba mengalihkan link.");
    }
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}