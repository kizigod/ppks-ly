require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const passport = require('passport');
const path = require('path');
const { createCanvas, loadImage } = require('canvas'); 
const QRCode = require('qrcode'); 

// IMPORT MODEL
const Url = require('./models/UrlModel');
const User = require('./models/UserModel');

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

app.set('trust proxy', 1);
app.use(session({
    secret: process.env.SESSION_SECRET || 'sawit-rahasia-usu',
    resave: false,
    saveUninitialized: false,
    proxy: true, 
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- 3. GOOGLE OAUTH STRATEGY ---
const OFFICIAL_DOMAIN = process.env.DOMAIN || "http://localhost:3000";

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // HARUS pakai process.env.DOMAIN, JANGAN "/auth/google/callback" saja
    callbackURL: process.env.DOMAIN + "/auth/google/callback", 
    proxy: true // WAJIB TRUE
}, 
async (accessToken, refreshToken, profile, done) => {
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

// --- FUNGSI GENERATE QR DENGAN LOGO (Format JPEG) ---
// --- FUNGSI GENERATE QR DENGAN LOGO (Versi Kebal) ---
async function generateQRWithLogo(text) {
    try {
        // 1. Buat QR Code jadi gambar Base64 (Virtual Image)
        const qrBase64 = await QRCode.toDataURL(text, {
            errorCorrectionLevel: 'H', // Level High agar QR tetap terbaca meski ketutupan logo
            margin: 2,
            width: 400, // Kunci ukuran tetap 400
            color: { dark: '#000000', light: '#ffffff' }
        });

        // 2. Load gambar QR dan gambar Logo secara bersamaan
        const qrImage = await loadImage(qrBase64);
        const logoPath = path.join(__dirname, 'public', 'images', 'logo-ppks.png');
        const logoImage = await loadImage(logoPath);

        // 3. Siapkan Kanvas Baru (Ini kanvas utama kita)
        const canvas = createCanvas(400, 400);
        const ctx = canvas.getContext('2d');

        // 4. Tempel QR Code sebagai Background
        ctx.drawImage(qrImage, 0, 0, 400, 400);

        // 5. Hitung Posisi Logo di Tengah
        const logoSize = 400 * 0.25; // Logo ukuran 25% dari QR
        const x = (400 - logoSize) / 2;
        const y = (400 - logoSize) / 2;

        // 6. Buat kotak putih di tengah agar QR tidak nabrak logo
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 5, y - 5, logoSize + 10, logoSize + 10);
        
        // 7. Tempel Logonya di atas kotak putih
        ctx.drawImage(logoImage, x, y, logoSize, logoSize);

        // Selesai! Ubah ke JPEG dan kirim ke Frontend
        return canvas.toDataURL('image/jpeg', 0.9);
        
    } catch (error) {
        console.error("⚠️ Gagal membuat QR Berlogo:", error.message);
        // Fallback: Kalau logo gagal dimuat, kirim QR polos aja
        return QRCode.toDataURL(text, { width: 400, margin: 2 });
    }
}

// --- 4. ROUTES ---
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
        const qrData = await generateQRWithLogo(shortUrl); 
        
        res.json({ shortUrl, qrData, shortCode }); 
    } catch (err) { res.status(500).json({ message: 'Gagal memproses link', error: err.message }); }
});

// Route lainnya (Visitor, Auth, Redirect)
app.get('/api/visitor/track', async (req, res) => {
    try {
        await connectDB();
        const newVisitor = new Visitor({ ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress });
        await newVisitor.save();
        const count = await Visitor.countDocuments();
        const totalClicksResult = await Url.aggregate([{ $group: { _id: null, total: { $sum: "$clicks" } } }]);
        const totalClicks = totalClicksResult.length > 0 ? totalClicksResult[0].total : 0;
        res.json({ totalVisitors: count, totalClicks: totalClicks });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard.html'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });
app.get('/api/user/status', (req, res) => { res.json(req.isAuthenticated() ? { loggedIn: true, user: req.user } : { loggedIn: false }); });

app.get('/api/user/links', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Harus login' });
    try {
        await connectDB();
        const links = await Url.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.json(links);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/:code*', async (req, res) => {
    const code = req.params.code + (req.params[0] || "");
    if (code.includes('.') || code.startsWith('api/')) return;
    try {
        await connectDB();
        const url = await Url.findOne({ shortCode: code });
        if (url) {
            await Url.updateOne({ _id: url._id }, { $inc: { clicks: 1 } });
            return res.redirect(url.originalUrl);
        }
        res.status(404).send("ID Pohon tidak ditemukan.");
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/test-qr', async (req, res) => {
    // Kita tes buat satu QR Code secara langsung
    const qrTest = await generateQRWithLogo("https://ppksly.idnusa.space/TEST");
    res.send(`<h1>Tes QR Code Backend</h1><img src="${qrTest}" style="border: 1px solid black;">`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server jalan di port ${PORT}`));

module.exports = app;