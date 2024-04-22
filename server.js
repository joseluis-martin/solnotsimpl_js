const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const xml2js = require('xml2js');
const builder = new xml2js.Builder();
const axios = require('axios');
const xmlparser = require('express-xml-bodyparser');
const app = express();
const upload = multer({ dest: 'uploads/' });
const port = 5999;
const sql = require('mssql');

const instance = axios.create({
    httpsAgent: new https.Agent({  
        rejectUnauthorized: false // Desactiva la validación de certificados
    })
});

// Middleware para parsear JSON en las respuestas entrantes
app.use(express.json());

app.use(xmlparser());

// Servir archivos estáticos (HTML, CSS, JS, etc.)
app.use(express.static('public'));

const config = {
    user: 'notassimples',  // Usuario de la base de datos
    password: 'akdsuTR54%',  // Contraseña del usuario
    server: '192.168.100.8',  // Dirección IP y puerto del servidor SQL Server
    port: 1433,
    database: 'tasadores',  // Nombre de la base de datos
    options: {
        encrypt: false,  // Generalmente, para conexiones locales no es necesario cifrar
        enableArithAbort: true
    }
};

async function fetchNifForPeticiones() {
    try {
        await sql.connect(config);
        const peticiones = await sql.query`SELECT idPeticion FROM peticiones WHERE idEstado = 0`;

        for (let i = 0; i < peticiones.recordset.length; i++) {
            const idPeticion = peticiones.recordset[i].idPeticion;
            const datosSolicitud = await sql.query`SELECT * FROM datosSolicitud WHERE idPeticion = ${idPeticion}`;

            // Si idTipoSolicitud es 1, devolvemos el nifTitular
            if (datosSolicitud.recordset[0].idTipoSolicitud === 1) {
                return{
                    nifTitular: datosSolicitud.recordset[0].nifTitular,
                    idPeticion: idPeticion
            };
        }
    }

        throw new Error("No se encontró un registro válido en datosSolicitud con idTipoSolicitud = 1.");
    } catch (err) {
        console.error('Error en la base de datos:', err);
        throw err;
    } finally {
        await sql.close();
    }
}

async function updateXML(data) {
    const {nifTitular, idPeticion } = data;
    const xml = fs.readFileSync('./xml/peticion_x_titular.xml', 'utf-8');

    xml2js.parseString(xml, async (err, result) => {
        if (err) {
            throw err;
        }

        // Actualizar el NIF en el XML
        result['corpme-floti'].peticiones[0].peticion[0].titular[0].nif[0] = nifTitular;

        const newXml = builder.buildObject(result);
        fs.writeFileSync(`./xml/peticion_x_titular ${idPeticion}.xml`, newXml);
        console.log('Archivo XML actualizado correctamente.');
    });
}



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
            console.log("El valor de la variable es: " + entidad);
            console.log("El valor de la variable es: " + email);
            console.log("El valor de la variable es: " + identificador);

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

app.post('/spnts', async (req, res) => {
    console.log('Tipo de Contenido:', req.headers['content-type']);
    console.log('Cuerpo de la Solicitud:', req.body);
    try {
        const xmlData = req.body; // El cuerpo de la solicitud ya es un objeto JavaScript

        // Acceder a la estructura del objeto
        const corpmeFloti = xmlData['corpme-floti'];
        if (corpmeFloti && corpmeFloti.respuesta && corpmeFloti.respuesta.length > 0) {
            const respuesta = corpmeFloti.respuesta[0];

            // Acceder a los elementos dentro de 'respuesta'
            const identificador = respuesta.identificador ? respuesta.identificador[0] : null;
            const referencia = respuesta.referencia ? respuesta.referencia[0] : null;
            const tipoRespuesta = respuesta['tipo-respuesta'] ? respuesta['tipo-respuesta'][0] : null;
            const fechaHora = respuesta['fecha-hora'] ? respuesta['fecha-hora'][0] : null;
            const informacion = respuesta.informacion ? respuesta.informacion[0] : null;

            // Procesar la información, como extraer el fichero PDF si está presente
            let ficheroPdfBase64;
            if (informacion && informacion.fichero && informacion.fichero.length > 0) {
                ficheroPdfBase64 = informacion.fichero[0]['_']; // Suponiendo que es un elemento de texto
                // Aquí puedes decodificar el Base64 y guardar el PDF si es necesario
            }

            const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');
            const pdfFilePath = './pdf/NotaSimple.pdf';
            fs.writeFile(pdfFilePath, pdfBuffer, (err) => {
                if (err) {
                    console.error('Error al guardar el archivo PDF:', err);
                    res.status(500).send('Error al guardar el archivo PDF');
                    return;
                }
            });

            console.log(identificador +' '+ referencia +' '+ fechaHora);
       // Leer el XML de confirmación
       const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');

       // Establecer el tipo de contenido y enviar el XML de confirmación
       res.set('Content-Type', 'text/xml');
       res.send(confirmacionXml);

        } else {
            res.status(400).send('Formato de XML inválido o datos faltantes');
        }

 

    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la respuesta');
    }
});

// const privateKey = fs.readFileSync('Certificado_SSL\\proytasv.depeca.uah.es.pem', 'utf8');
// const certificate = fs.readFileSync('Certificado_SSL\\proytasv_depeca_uah_es_cert.cer', 'utf8');
// const credentials = { key: privateKey, cert: certificate };

// Ruta de tu archivo .pfx y su contraseña
const pfxPath = 'Certificado_SSL/certificate.pfx';
const pfxPassword = 'M4s72aKalo';

// Opciones de HTTPS incluyendo el archivo .pfx y la contraseña
const credentials = {
    pfx: fs.readFileSync(pfxPath),
    passphrase: pfxPassword
};
const httpsServer = https.createServer(credentials, app);

httpsServer.listen(port, () => {
    console.log(`Servidor escuchando en https://localhost:${port}`);
});

fetchNifForPeticiones()
    .then(updateXML)
    .catch(console.error);