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

// 1. KONEKSI DATABASE (Ditingkatkan untuk Vercel)
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
        await connectDB(); // Pastikan DB konek
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

// PERBAIKAN: deserializeUser menggunakan async/await agar tidak Server Error
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/user/status', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ loggedIn: true, user: req.user });
    } else {
        res.json({ loggedIn: false });
    }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/dashboard.html'); }
);

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

app.get('/api/user/links', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Login dulu' });
    try {
        await connectDB();
        const links = await Url.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.json(links);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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

        const shortUrl = `${process.env.BASE_URL}/${shortCode}`;
        const qrCodeData = await QRCode.toDataURL(shortUrl);

        res.json({ shortUrl, qrData: qrCodeData });
    } catch (err) {
        res.status(500).json({ message: 'Gagal memproses data', error: err.message });
    }
});

app.get('/:code', async (req, res) => {
    try {
        await connectDB();
        const url = await Url.findOne({ shortCode: req.params.code });
        if (url) {
            url.clicks++;
            await url.save();
            return res.redirect(url.originalUrl);
        }
        return res.status(404).send('Link tidak ditemukan');
    } catch (err) { res.status(500).send('Server error'); }
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}