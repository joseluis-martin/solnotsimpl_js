const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');

const app = express();
const port = 443;

const instance = axios.create({
    httpsAgent: new https.Agent({  
        rejectUnauthorized: false // Desactiva la validación de certificados
    })
});

// Configuración para multer
const upload = multer({ dest: 'uploads/' });

// Servir archivos estáticos (HTML, CSS, JS, etc.)
app.use(express.static('public'));

// Ruta principal para servir la página HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

// Ruta para manejar el formulario enviado
app.post('/sendXML', upload.single('file'), async (req, res) => {
    try {
        const xmlData = fs.readFileSync(req.file.path, 'utf8');

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml' },
            data: xmlData,
            url: 'https://test.registradores.org/xmlpeticion'
        };

        const response = await instance(options);

        // Puedes enviar una página o mensaje de respuesta aquí
        res.send(`<pre>${response.data}</pre>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la petición');
    }
});

const privateKey = fs.readFileSync('./certificados/proytasv.depeca.uah.es.pem', 'utf8');
const certificate = fs.readFileSync('./certificados/proytasv_depeca_uah_es_cert.cer', 'utf8');
const credentials = { key: privateKey, cert: certificate };

const httpsServer = https.createServer(credentials, app);

httpsServer.listen(port, () => {
    console.log(`Servidor escuchando en https://localhost:${port}`);
});
