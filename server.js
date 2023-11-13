const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = 443;

// Configuración para multer
const upload = multer({ dest: 'uploads/' });

// Servir archivos estáticos (HTML, CSS, JS, etc.)
app.use(express.static('public'));

// Ruta principal para servir la página HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

// Ruta para manejar la petición AJAX
app.post('/sendXML', upload.single('file'), async (req, res) => {
    // ... el resto de tu código para manejar la petición ...
});

// Leer los certificados SSL
const privateKey = fs.readFileSync('proytasv.depeca.uah.es.pem', 'utf8');
const certificate = fs.readFileSync('proytasv_depeca_uah_es_cert.cer', 'utf8');
const credentials = { key: privateKey, cert: certificate };

// Crear servidor HTTPS
const httpsServer = https.createServer(credentials, app);

httpsServer.listen(port, () => {
    console.log(`Servidor escuchando en https://localhost:${port}`);
});
