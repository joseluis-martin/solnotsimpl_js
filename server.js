const express = require('express');
const https = require('https');
// const http = require('http');
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
    }),
    timeout: 10000  // Timeout de 5000 ms (5 segundos)
});

// Middleware para parsear JSON en las respuestas entrantes
app.use(express.json());

app.use(xmlparser());

// Servir archivos estáticos (HTML, CSS, JS, etc.)
app.use(express.static('public'));

// Configuración para acceder a la BBDD de tasadores
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

async function fetchPendingRequests() {
    let resultadosTitular = [];  // Crear un array para almacenar las solicitudes por titular
    let resultadosIDUFIR = [];  // Crear un array para almacenar las solicitudes por IDUFIR
    let resultadosFinca = [];  // Crear un array para almacenar los resultados de finca

    try {
        await sql.connect(config);
        const peticiones = await sql.query`SELECT idPeticion FROM peticiones WHERE idEstado = 0`;
        
       // Recorrer cada petición encontrada
        for (let i = 0; i < peticiones.recordset.length; i++) {
            const idPeticion = peticiones.recordset[i].idPeticion;
            const datosSolicitud = await sql.query`SELECT * FROM datosSolicitud WHERE idPeticion = ${idPeticion}`;

            // Si idTipoSolicitud es 0, almacenamos los datos de finca en el array
            if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 0) {
                resultadosFinca.push({
                    codigoRegistro: datosSolicitud.recordset[0].codigoRegistro,
                    municipio: datosSolicitud.recordset[0].municipio,
                    provincia: datosSolicitud.recordset[0].provincia,
                    seccion: datosSolicitud.recordset[0].seccion,
                    finca: datosSolicitud.recordset[0].finca,
                    idPeticion: idPeticion
                });
            }
            // Si idTipoSolicitud es 1, almacenamos el nifTitular y el idPeticion en el array
            else if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 1) {
                resultadosTitular.push({
                    nifTitular: datosSolicitud.recordset[0].nifTitular,
                    idPeticion: idPeticion
                });
            }
            // Si idTipoSolicitud es 2, almacenamos el IDUFIR y el idPeticion en el array
            else if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 2) {
                resultadosIDUFIR.push({
                    IDUFIR: datosSolicitud.recordset[0].IDUFIR,
                    idPeticion: idPeticion
                });
            }

        }

        // Verificar si se encontraron resultados

        if (resultadosFinca.length > 0) {
            console.log("Resultados de finca encontrados:", resultadosFinca);
        } else {
            //console.log("No se encontraron registros válidos para finca o el idTipoSolicitud no es 0.");
        }

        if (resultadosTitular.length > 0) {
            console.log("Resultados de titulares encontrados:", resultadosTitular);
        } else {
           // console.log("No se encontraron registros válidos para titulares o el idTipoSolicitud no es 1.");
        }

        if (resultadosIDUFIR.length > 0) {
            console.log("Resultados de IDUFIR encontrados:", resultadosIDUFIR);
        } else {
            //console.log("No se encontraron registros válidos para IDUFIR o el idTipoSolicitud no es 2.");
        }

        return { resultadosTitular, resultadosIDUFIR, resultadosFinca };  // Devolver todos los arrays de resultados
    } catch (err) {
        console.error('Error en la base de datos:', err);
        throw err;  // Lanzar el error
    } finally {
        await sql.close();  // Asegurar que la conexión se cierre
    }
}

async function sendXMLxTitular(resultados) {
    for (let data of resultados) {
        // console.log(data);
        const { nifTitular, idPeticion } = data;
        const xml = fs.readFileSync('./xml/peticion_x_titular.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xml);
            parsedXml['corpme-floti'].peticiones[0].peticion[0].titular[0].nif[0] = nifTitular;
            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml/peticion_x_titular_${idPeticion}.xml`, newXml);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                //url: 'http://localhost:3000/xmlpeticion',
                url: 'https://test.registradores.org/xmlpeticion',
            };

            const response = await instance(options);
            if (response.data) {
                fs.writeFileSync(`./xml/acuseRecibido_${idPeticion}.xml`, response.data);
                const receiptXml = await xml2js.parseStringPromise(response.data);
                handleReceipt(receiptXml, idPeticion);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                console.error('Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID:', idPeticion);
            } else if (error.response) {
                // El servidor respondió con un código de estado fuera del rango 2xx
                console.error('Error de respuesta del servidor para ID:', idPeticion, 'Código de estado:', error.response.status);
            } else if (error.request) {
                // La solicitud fue hecha pero no se recibió respuesta
                console.error('No se recibió respuesta para la solicitud del ID:', idPeticion);
            } else {
                // Algo ocurrió al configurar la solicitud que disparó un error
                console.error('Error configurando la solicitud para ID:', idPeticion);
            }
            console.error('Información del error:', error.message);  // Mensaje general del error
        }
    }
}

async function sendXMLxIDUFIR(resultados) {
    for (let data of resultados) {
        // console.log(data);
        const { IDUFIR, idPeticion } = data;
        const xml = fs.readFileSync('./xml/peticion_x_idufir.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xml);
            parsedXml['corpme-floti'].peticiones[0].peticion[0].idufir[0] = IDUFIR;
            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml/peticion_x_idufir_${idPeticion}.xml`, newXml);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                //url: 'http://localhost:3000/xmlpeticion',
                url: 'https://test.registradores.org/xmlpeticion',
            };

            const response = await instance(options);
            if (response.data) {
                fs.writeFileSync(`./xml/acuseRecibido_${idPeticion}.xml`, response.data);
                const receiptXml = await xml2js.parseStringPromise(response.data);
                handleReceipt(receiptXml, idPeticion);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                console.error('Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID:', idPeticion);
            } else if (error.response) {
                console.error('Error de respuesta del servidor para ID:', idPeticion, 'Código de estado:', error.response.status);
            } else if (error.request) {
                console.error('No se recibió respuesta para la solicitud del ID:', idPeticion);
            } else {
                console.error('Error configurando la solicitud para ID:', idPeticion);
            }
            console.error('Información del error:', error.message);  // Mensaje general del error
        }
    }
}

async function sendXMLxFinca(resultados) {
    for (let data of resultados) {
        // console.log(data);
        const { codigoRegistro, municipio, provincia, seccion, finca, idPeticion } = data;
        const xml = fs.readFileSync('./xml/peticion_x_finca.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xml);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].registro[0] = parseInt(codigoRegistro, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].municipio[0] = parseInt(municipio, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].provincia[0] = parseInt(provincia, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].seccion[0] = parseInt(seccion, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].finca[0] = parseInt(finca, 10);
        

            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml/peticion_x_finca_${idPeticion}.xml`, newXml);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                //url: 'http://localhost:3000/xmlpeticion',
                url: 'https://test.registradores.org/xmlpeticion',
            };

            const response = await instance(options);
            if (response.data) {
                fs.writeFileSync(`./xml/acuseRecibido_${idPeticion}.xml`, response.data);
                const receiptXml = await xml2js.parseStringPromise(response.data);
                handleReceipt(receiptXml, idPeticion);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                console.error('Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID:', idPeticion);
            } else if (error.response) {
                console.error('Error de respuesta del servidor para ID:', idPeticion, 'Código de estado:', error.response.status);
            } else if (error.request) {
                console.error('No se recibió respuesta para la solicitud del ID:', idPeticion);
            } else {
                console.error('Error configurando la solicitud para ID:', idPeticion);
            }
            console.error('Información del error:', error.message);  // Mensaje general del error
        }
    }
}

async function handleReceipt(receipt, idPeticion) {
    // Suponemos que estamos tratando con un solo acuse
    // Verificar si la respuesta general contiene un error
    if (receipt && receipt['corpme-floti'] && receipt['corpme-floti'].error) {
        // Extraer el código de error
        const codigo = receipt['corpme-floti'].error[0]['$'].codigo;
        console.error(`Error general en el XML recibido para ID ${idPeticion}: ${receipt['corpme-floti'].error[0]['_']} (Código ${codigo})`);

        // Conectar a la base de datos y actualizar el estado y el código de error
        await sql.connect(config);
        await sql.query`UPDATE peticiones SET idEstado = 3, idError = ${codigo} WHERE idPeticion = ${idPeticion}`;
        console.log(`Estado actualizado a 3 y error registrado para idPeticion ${idPeticion}`);

    } else if (receipt && receipt['corpme-floti'] && receipt['corpme-floti']['acuses'] && receipt['corpme-floti']['acuses'][0]['acuse']) {
        // Acceder al objeto 'acuse'
        const acuse = receipt['corpme-floti']['acuses'][0]['acuse'][0];

            // Verificar si el acuse contiene un error
            if (acuse.error) {
                const codigo = acuse.error[0]['$'].codigo;
                const mensaje = acuse.error[0]['_'];
                console.error(`Error específico en el acuse para ID ${idPeticion}: ${mensaje} (Código ${codigo})`);

                // Conectar a la base de datos y actualizar el estado y el código de error
                await sql.connect(config);
                await sql.query`UPDATE peticiones SET idEstado = 3, idError = ${codigo} WHERE idPeticion = ${idPeticion}`;
                console.log(`Estado actualizado a 3 y error registrado para idPeticion ${idPeticion}`);
                
            } else {
            const acuse = receipt['corpme-floti']['acuses'][0]['acuse'][0];
            try {
                await sql.connect(config);
                await sql.query`UPDATE peticiones SET idEstado = 1, idError = NULL WHERE idPeticion = ${idPeticion}`;
                console.log(`Estado actualizado a 1 para idPeticion ${idPeticion}`);

                // Procesar cada identificador (si hay varios, sería acuse['identificador'].forEach(...))
                if (acuse['identificador']) {
                    for (const identificador of acuse['identificador']) {
                        await sql.query`UPDATE peticiones SET idCorpme = ${identificador} WHERE idPeticion = ${idPeticion}`;
                        console.log(`Identificador actualizado a ${identificador} para idPeticion ${idPeticion}`); 
                    }
                }
            } catch (err) {
                console.error('Error al realizar operaciones en la base de datos:', err);
            } finally {
                await sql.close();
            }
        }
    }
}

 // Ruta principal para servir la página HTML
    app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

app.get('/ping', (req, res) => {
    res.send('Pong!');
});

app.post('/spnts', async (req, res) => {
    // console.log('Tipo de Contenido:', req.headers['content-type']);
    // console.log('Cuerpo de la Solicitud:', req.body);
    try {
        const xmlData = req.body; // El cuerpo de la solicitud ya es un objeto JavaScript
        // Verificar el tipo de XML recibido
        if (xmlData['corpme-floti']) {
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
                
                    // Conectar a la base de datos y guardar el PDF
                    try {
                        await sql.connect(config);
                        const query = `UPDATE peticiones SET pdf = @pdf, IdEstado = 4 WHERE idCorpme = @idCorpme`;
                        const request = new sql.Request();
                        
                        // Convertir el base64 a un buffer binario
                        const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');
                        
                        // Añadir el PDF como un parámetro varbinary
                        request.input('pdf', sql.VarBinary(sql.MAX), pdfBuffer);
                        request.input('idCorpme', sql.VarChar(50), identificador);
                        await request.query(query);
                        
                        console.log(identificador);
                        console.log('PDF guardado en la base de datos exitosamente.');

                        // Leer el XML de confirmación
                        const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');

                        // Establecer el tipo de contenido y enviar el XML de confirmación
                        res.set('Content-Type', 'text/xml');
                        res.send(confirmacionXml);

                    } catch (err) {
                        console.error('Error al guardar en la base de datos:', err);
                        res.status(500).send('Error al guardar el PDF en la base de datos');
                        return;
                    }
                }

            } else {
                res.status(400).send('Formato de XML inválido o datos faltantes');
            }

        } else if (xmlData['corpme-floti-facturacion']) {
            // Procesar el segundo tipo de XML
            const corpmeFlotiFacturacion = xmlData['corpme-floti-facturacion'];
            const facturacion = corpmeFlotiFacturacion.facturacion;

            // Iterar sobre las facturas
            for (const factura of facturacion.factura) {
                const ejercicio = factura.ejercicio;
                const fecha = factura.fecha;
                const numero = factura.numero;
                const regimenCaja = factura['regimen-caja'];
                const serie = factura.serie;

                const emisor = factura.emisor;
                const destinatario = factura.destinatario;
                const importe = factura.importe;
                const peticion = factura.peticion;

                const emisorData = {
                    cp: emisor.cp,
                    domicilio: emisor.domicilio,
                    municipio: emisor.municipio,
                    nif: emisor.nif,
                    nombre: emisor.nombre,
                    provincia: emisor.provincia
                };

                const destinatarioData = {
                    cp: destinatario.cp,
                    domicilio: destinatario.domicilio,
                    municipio: destinatario.municipio,
                    nif: destinatario.nif,
                    nombre: destinatario.nombre,
                    provincia: destinatario.provincia
                };

                const importeData = {
                    base: importe.base,
                    impuesto: importe.impuesto,
                    irpf: importe.irpf,
                    total: importe.total
                };

                const peticionData = {
                    destino: peticion.destino,
                    fecha: peticion.fecha,
                    fechaRespuesta: peticion['fecha-respuesta'],
                    grupo: peticion.grupo,
                    id: peticion.id,
                    importeBase: peticion['importe-base'],
                    porcentajeImpuesto: peticion['porcentaje-impuesto'],
                    referencia: peticion.referencia,
                    tipo: peticion.tipo,
                    usuario: peticion.usuario
                };

                // Aquí podrías agregar el procesamiento necesario para la facturación
                console.log('Factura procesada:', {
                    ejercicio, fecha, numero, regimenCaja, serie, emisorData, destinatarioData, importeData, peticionData
                });

                // Por ejemplo, almacenar en la base de datos, etc.
            }

            // Construir el XML de confirmación para corpme-floti-facturacion
            const builder = require('xmlbuilder');
            const confirmacionFacturacionXml = builder.create('corpme-floti-facturacion', { encoding: 'UTF-8' })
                .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
                .att('id', corpmeFlotiFacturacion['@id'])  // Utilizar el mismo id del XML recibido
                .att('xsi:noNamespaceSchemaLocation', 'https://www.test.registradores.org/schema/floti/facturacion.xsd')
                .ele('ok')
                .end({ pretty: true });
            // Enviar la respuesta XML de confirmación
            res.set('Content-Type', 'text/xml');
            res.send(confirmacionFacturacionXml);

        } else {
            res.status(400).send('Formato de XML no soportado');
        }

    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la respuesta');
    }
});


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

// Servidor HTTP para manejo de desafíos Let's Encrypt
//const httpApp = express();
//httpApp.use(express.static('public'));

//httpApp.get('/.well-known/acme-challenge/:content', (req, res) => {
//    const content = req.params.content;
//    const filePath = path.join(__dirname, 'public/.well-known/acme-challenge', content);
//    res.sendFile(filePath);
//});

//const httpServer = http.createServer(httpApp);
//httpServer.listen(httpPort, () => {
//    console.log(`Servidor HTTP escuchando en el puerto ${httpPort} para los desafíos de LetsEncrypt`);
//});

function runFetchPendingRequests() {
    fetchPendingRequests()
        .then(data => {
            if (data) {
                if (data.resultadosTitular.length > 0) {
                    sendXMLxTitular(data.resultadosTitular);
                }
                if (data.resultadosIDUFIR.length > 0) {
                    sendXMLxIDUFIR(data.resultadosIDUFIR);
                }
                if (data.resultadosFinca.length > 0) {
                    sendXMLxFinca(data.resultadosFinca);
                }
            } else {
                console.log("No hay solicitudes sin tramitar.");
            }
        })
        .catch(console.error);
}

    // Configurar la función para ejecutarse cada 10 minutos (600000 milisegundos)
setInterval(runFetchPendingRequests, 60000);       