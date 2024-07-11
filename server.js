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

// Ruta para manejar solicitudes POST en /spnts
app.post('/spnts', async (req, res) => {
    try {
        const xmlData = req.body;

        // Verificar el tipo de XML y procesarlo en consecuencia
        if (xmlData['corpme-floti']) {
            await processCorpmeFloti(xmlData, res);
        } else if (xmlData['corpme-floti-facturacion']) {
            await processCorpmeFlotiFacturacion(xmlData, res);
        } else {
            res.status(400).send('Formato de XML inválido o datos faltantes');
        }

    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la respuesta');
    }
});

// Función para procesar el XML de tipo 'corpme-floti'
async function processCorpmeFloti(xmlData, res) {
    const corpmeFloti = xmlData['corpme-floti'];
    if (corpmeFloti && corpmeFloti.respuesta && corpmeFloti.respuesta.length > 0) {
        const respuesta = corpmeFloti.respuesta[0];
        const identificador = respuesta.identificador ? respuesta.identificador[0] : null;
        const informacion = respuesta.informacion ? respuesta.informacion[0] : null;

        let ficheroPdfBase64;
        if (informacion && informacion.fichero && informacion.fichero.length > 0) {
            ficheroPdfBase64 = informacion.fichero[0]['_'];

            try {
                // Conexión a la base de datos
                await sql.connect(config);
                const query = `UPDATE peticiones SET pdf = @pdf, IdEstado = 4 WHERE idCorpme = @idCorpme`;
                const request = new sql.Request();
                const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');
                request.input('pdf', sql.VarBinary(sql.MAX), pdfBuffer);
                request.input('idCorpme', sql.VarChar(50), identificador);
                await request.query(query);

                console.log(identificador);
                console.log('PDF guardado en la base de datos exitosamente.');

                // Leer y enviar XML de confirmación
                const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
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
}

 // Función para procesar el XML de tipo 'corpme-floti-facturacion'
async function processCorpmeFlotiFacturacion(xmlData, res) {
    const facturacion = xmlData['corpme-floti-facturacion'];
    const facturacionData = facturacion.facturacion ? facturacion.facturacion[0] : null;
    if (facturacionData) {
        // Extraer datos principales de facturación
        const facturacionId = facturacionData.$.id;
        const importeBase = facturacionData.$['importe-base'];
        const importeImpuesto = facturacionData.$['importe-impuesto'];
        const periodoInicio = facturacionData.$['periodo-inicio'];
        const periodoFin = facturacionData.$['periodo-fin'];

        try {
            // Conexión a la base de datos
            await sql.connect(config);

            // Insertar datos en la tabla facturación_factura
            const facturaQuery = `INSERT INTO facturacion_factura (factura_id, "factura_importe-base", "factura_importe-impuesto", "factura_periodo-inicio", "factura_periodo-fin") 
                                  VALUES (@facturacion_id, @importe_base, @importe_impuesto, @periodo_inicio, @periodo_fin);
                                  SELECT SCOPE_IDENTITY() AS id;`;
            const requestFactura = new sql.Request();
            requestFactura.input('facturacion_id', sql.VarChar(50), facturacionId);
            requestFactura.input('importe_base', sql.Money, parseFloat(importeBase));
            requestFactura.input('importe_impuesto', sql.Money, parseFloat(importeImpuesto));
            requestFactura.input('periodo_inicio', sql.SmallDateTime, new Date(periodoInicio));
            requestFactura.input('periodo_fin', sql.SmallDateTime, new Date(periodoFin));

            const result = await requestFactura.query(facturaQuery);
            const facturaId = result.recordset[0].id;

            // Insertar datos de cada factura en la tabla facturación_peticion
            for (let factura of facturacionData.factura) {
                const peticion = factura.peticion ? factura.peticion[0] : null;
                if (peticion) {
                    // Extraer datos de la petición
                    const facturaId = facturacionId;
                    const grupo = peticion.$['grupo'];
                    const id = peticion.$['id'];
                    const usuario = peticion.$['usuario'];
                    const fecha = peticion.$['fecha'];
                    const fechaRespuesta = peticion.$['fecha-respuesta'];
                    const tipo = peticion.$['tipo'];
                    const importeBasePeticion = peticion.$['importe-base'];
                    const porcentajeImpuesto = peticion.$['porcentaje-impuesto'];

                    // Insertar datos en la tabla facturación_peticion
                    const peticionQuery = `INSERT INTO facturacion_peticion (factura_id, peticion_grupo, peticion_id, peticion_usuario, peticion_fecha, "peticion_fecha-respuesta", peticion_tipo, "peticion_importe-base", "peticion_porcentaje-impuesto") 
                                           VALUES (@factura_id, @grupo, @id, @usuario, @fecha, @fecha_respuesta, @tipo, @importe_base, @porcentaje_impuesto);`;
                    const requestPeticion = new sql.Request();
                    requestPeticion.input('factura_id', sql.Int, facturaId);
                    requestPeticion.input('grupo', sql.VarChar(50), grupo);
                    requestPeticion.input('id', sql.VarChar(50), id);
                    requestPeticion.input('usuario', sql.VarChar(50), usuario);
                    requestPeticion.input('fecha', sql.SmallDateTime, new Date(fecha));
                    requestPeticion.input('fecha_respuesta', sql.SmallDateTime, new Date(fechaRespuesta));
                    requestPeticion.input('tipo', sql.Int(4), tipo);
                    requestPeticion.input('importe_base', sql.Money, parseFloat(importeBasePeticion));
                    requestPeticion.input('porcentaje_impuesto', sql.Decimal(5, 2), parseFloat(porcentajeImpuesto));

                    await requestPeticion.query(peticionQuery);
                }
            }

            res.send('Datos de facturación guardados exitosamente.');

        } catch (err) {
            console.error('Error al guardar en la base de datos:', err);
            res.status(500).send('Error al guardar los datos de facturación en la base de datos');
            return;
        }
    } else {
        res.status(400).send('Formato de XML inválido o datos faltantes');
    }
}


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