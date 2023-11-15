const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const xml2js = require('xml2js');
const axios = require('axios');

const app = express();
const upload = multer({ dest: 'uploads/' });
const port = 443;

const instance = axios.create({
    httpsAgent: new https.Agent({  
        rejectUnauthorized: false // Desactiva la validación de certificados
    })
});

// Middleware para parsear JSON en las respuestas entrantes
app.use(express.json());
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
        });

        // Parsear el XML del acuse de recibo
        xml2js.parseString(response.data, (err, result) => {
            if (err) {
                // Manejar errores de parseo
                console.error('Error al parsear el XML:', err);
                return;
            }

            // Imprimir los campos del XML en la consola
            console.log('Acuse de Recibo:', result);
            
            // Extraer los campos deseados
            const entidad = result['corpme-floti'].acuses[0].credenciales[0].entidad[0];
            const email = result['corpme-floti'].acuses[0].credenciales[0].email[0];
            const identificador = result['corpme-floti'].acuses[0].acuse[0].identificador[0];

            // Aquí puedes acceder a campos específicos del XML
            // Por ejemplo: console.log(result.nombreDelCampo);
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
                        <ul>
                            <li>Entidad: ${entidad}</li>
                            <li>Email: ${email}</li>
                            <li>Referencia: ${identificador}</li>
                        </ul>
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

app.post('/spnts', (req, res) => {
    try {
        // Obtener los datos XML (asumiendo que están en el cuerpo de la solicitud)
        const xmlData = req.body;

        // Parsear el XML y extraer el PDF codificado en Base64
        xml2js.parseString(xmlData, (err, result) => {
            if (err) {
                throw err; // o manejar el error adecuadamente
            }

            // Extraer la cadena Base64 (ajustar según la estructura real del XML)
            const base64data = result.documento.pdf[0];

            // Decodificar de Base64 a binario y guardar el archivo PDF
            const pdfBuffer = Buffer.from(base64data, 'base64');
            fs.writeFileSync('documentoRecibido.pdf', pdfBuffer);

            // Confirmar la recepción
            res.status(200).send('Respuesta recibida y procesada.');
        });

        // Leer el XML de confirmación
        const confirmacionXml = fs.readFileSync(path.join(__dirname, '.xml/corpme_floti_ok.xml'), 'utf8');

        // Establecer el tipo de contenido y enviar el XML de confirmación
        res.set('Content-Type', 'text/xml');
        res.send(confirmacionXml);

    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la respuesta');
    }
});

const privateKey = fs.readFileSync('./certificados/proytasv.depeca.uah.es.pem', 'utf8');
const certificate = fs.readFileSync('./certificados/proytasv_depeca_uah_es_cert.cer', 'utf8');
const credentials = { key: privateKey, cert: certificate };

const httpsServer = https.createServer(credentials, app);

httpsServer.listen(port, () => {
    console.log(`Servidor escuchando en https://localhost:${port}`);
});
