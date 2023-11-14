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
            url: 'https://test.registradores.org/xmlpeticion',
        };

        const response = await instance(options);

        // Guardar la respuesta en un archivo XML
        fs.writeFile('./xml/acuseRecibido.xml', response.data, (err) => {
            if (err) {
                console.error('Error al guardar el archivo:', err);
                res.status(500).send('Error al guardar el archivo');
                return;
            }

            // Enviar una confirmación o la respuesta al cliente
            res.send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <title>Acuse de Recibo Guardado</title>
                    <!-- Incluir aquí cualquier CSS o metadatos -->
                </head>
                <body>
                    <div class="container">
                        <h2>Acuse del Colegio de Registradores Guardado</h2>
                        <p>El acuse ha sido guardado exitosamente en un archivo XML.</p>
                    </div>
                </body>
                </html>
            `);
        });
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
