require('dotenv').config();
const QRCode = require('qrcode'); 
const express = require('express');
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const passport = require('passport');

// IMPORT MODEL (Pastikan file User.js sudah ada di folder models)
const Url = require('./models/Url');
const User = require('./models/User'); 

const app = express();

// 1. MIDDLEWARE DASAR (Urutan sangat penting!)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 2. MIDDLEWARE SESSION (Harus SEBELUM passport)
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-ppks-ly',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set false karena masih pakai HTTP localhost
}));

// 3. MIDDLEWARE PASSPORT
app.use(passport.initialize());
app.use(passport.session());

const path = require('path');

// Letakkan ini di atas semua route API
app.use(express.static(path.join(__dirname, 'public')));

// Penting: Pastikan rute utama melayani index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. STRATEGY GOOGLE (Perbaikan Callback & Proxy)
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "http://localhost:3000/auth/google/callback", // Pakai URL lengkap untuk localhost
    proxy: true
}, async (accessToken, refreshToken, profile, done) => {
    try {
        // PERBAIKAN: Cari user atau buat baru
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
passport.deserializeUser((id, done) => {
    User.findById(id).then(user => done(null, user));
});

// --- ROUTES ---

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
    (req, res) => { res.redirect('/dashboard.html'); } // Perbaikan: Tambahkan .html jika file kamu dashboard.html
);

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// Mendapatkan data link milik user
app.get('/api/user/links', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Login dulu' });
    try {
        const links = await Url.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.json(links);
    } catch (err) { res.status(500).send(err); }
});

// Shorten Link (Perbaikan: Simpan userId jika login)
app.post('/api/shorten', async (req, res) => {
    const { longUrl, customCode } = req.body;
    const shortCode = (customCode && customCode.trim()) || nanoid(6);

    try {
        let existing = await Url.findOne({ shortCode });
        if (existing) return res.status(400).json({ message: 'Nama sudah dipakai!' });

        const newUrl = new Url({ 
            originalUrl: longUrl, 
            shortCode,
            userId: req.isAuthenticated() ? req.user._id : null // SIMPAN USER ID
        });
        await newUrl.save();

        const shortUrl = `${process.env.BASE_URL}/${shortCode}`;
        const qrCodeData = await QRCode.toDataURL(shortUrl, {
            errorCorrectionLevel: 'H',
            margin: 1,
            color: { dark: '#4F46E5', light: '#FFFFFF' }
        });

        res.json({ shortUrl, qrData: qrCodeData });
    } catch (err) {
        res.status(500).json({ message: 'Gagal memproses data' });
    }
});

// Redirect Route
app.get('/:code', async (req, res) => {
    try {
        const url = await Url.findOne({ shortCode: req.params.code });
        if (url) {
            url.clicks++;
            await url.save();
            return res.redirect(url.originalUrl);
        }
        return res.status(404).send('Link tidak ditemukan');
    } catch (err) { res.status(500).send('Server error'); }
});

// Database & Server
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Terhubung ke MongoDB'))
    .catch(err => console.error(err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));