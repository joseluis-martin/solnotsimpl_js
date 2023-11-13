const express = require('express');
const https = require('https');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const multer = require('multer'); // Middleware para manejar 'multipart/form-data'

const app = express();
const port = 443;

// Configuración para multer (para manejar la carga de archivos)
const upload = multer({ dest: 'uploads/' });

// Rutas estáticas para servir archivos HTML, JS, CSS, etc.
app.use(express.static('public'));

// Ruta principal para servir la página HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

// Ruta para manejar la petición AJAX
// 'upload.single('file')' maneja la carga del archivo XML
app.post('/sendXML', upload.single('file'), async (req, res) => {
    try {
        // El archivo XML se almacena en 'req.file'
        const xmlData = fs.readFileSync(req.file.path, 'utf8');

        // Configurar opciones para la petición HTTPS
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml' },
            data: xmlData,
            url: 'https://test.registradores.org/xmlpeticion'
        };

        // Enviar petición al Colegio de Registradores
        const response = await axios(options);

        // Enviar respuesta al cliente
        res.send(response.data);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la petición');
    }
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
