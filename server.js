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

        // Recorrer cada peticion encontrada
        for (let i = 0; i < peticiones.recordset.length; i++) {
            const idPeticion = peticiones.recordset[i].idPeticion;
            const datosSolicitud = await sql.query`SELECT * FROM datosSolicitud WHERE idPeticion = ${idPeticion}`;

            // Si idTipoSolicitud es 1, devolvemos el nifTitular y el idPeticion
            if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 1) {
                return {
                    nifTitular: datosSolicitud.recordset[0].nifTitular,
                    idPeticion: idPeticion
                };
            }
        }

        // Si no se encontraron registros válidos o el bucle ha terminado sin retornar
        console.log("No se encontraron registros válidos o el idTipoSolicitud no es 1.");
        return null;  // Devolvemos null para indicar que no hay acción a realizar
    } catch (err) {
        console.error('Error en la base de datos:', err);
        throw err;  // Considera si quieres realmente lanzar el error o simplemente loguearlo
    } finally {
        await sql.close();
    }
}

async function updateXMLxTitular(data) {
    const {nifTitular, idPeticion } = data;
    const xml = fs.readFileSync('./xml/peticion_x_titular.xml', 'utf-8');

    xml2js.parseString(xml, async (err, result) => {
        if (err) {
            throw err;
        }

        // Actualizar el NIF en el XML y guarda el archivo
        result['corpme-floti'].peticiones[0].peticion[0].titular[0].nif[0] = nifTitular;
        const newXml = builder.buildObject(result);
        fs.writeFileSync(`./xml/peticion_x_titular ${idPeticion}.xml`, newXml);

        // Envía el archivo XML
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml' },
            datasent: newXml,
            url: 'https://test.registradores.org/xmlpeticion',
        };

        try {

            // const response = await instance(options);

            if (response.data) {

                // Guardar la respuesta en un archivo XML
                fs.writeFile(`./xml/acuseRecibido.xml ${idPeticion}`, response.data, (err) => {
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
                    else{
                        handleReceipt(result, idPeticion);
                    }
                });
            }

        } catch (error) {
            console.error('Error al enviar el archivo:', error);
        }
    });
}

async function handleReceipt(receipt, idPeticion) {
    // Suponemos que estamos tratando con un solo acuse
    const acuse = receipt['corpme-floti']['acuses'][0]['acuse'][0];

    // Verificar si hay un error en el acuse
    if (acuse['error']) {
        console.log('Error detectado en el acuse de recibo:', acuse['error'][0]);
        // Actualizar el estado a 3 si hay error
        try {
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET idEstado = 3 WHERE idPeticion = ${idPeticion}`;
            console.log(`Estado actualizado a 3 para idPeticion ${idPeticion}`);
        } catch (err) {
            console.error('Error al actualizar el estado en la base de datos:', err);
        } finally {
            await sql.close();
        }
    } else {
        // Si no hay error, actualizamos el estado a 1 y procesamos identificadores
        try {
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET idEstado = 1 WHERE idPeticion = ${idPeticion}`;
            console.log(`Estado actualizado a 1 para idPeticion ${idPeticion}`);

            // Procesar cada identificador (si hay varios, sería acuse['identificador'].forEach(...))
            if (acuse['identificador']) {
                for (const identificador of acuse['identificador']) {
                    await sql.query`INSERT INTO notasRecibidas (idCorpme, idPeticion) VALUES (${identificador}, ${idPeticion})`;
                    console.log(`Registro creado en notasRecibidas con idCorpme: ${identificador} y idPeticion: ${idPeticion}`);
                }
            }
        } catch (err) {
            console.error('Error al realizar operaciones en la base de datos:', err);
        } finally {
            await sql.close();
        }
    }
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
const pfxPath = './Certificado_SSL/2024/certificate.pfx';
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
    .then(data => {
        if (data) {
            updateXMLxTitular(data);
        } else {
            console.log("No hay solicitudes por titular sin tramitar.");
        }
    })
    .catch(console.error);