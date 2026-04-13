const express = require('express');
const logger = require('./logger'); // <-- Importamos el logger
const { verificarCarpetasEscritura, logEscritura } = require('./utils/verificadorEscritura');
const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const multer = require('multer');
const xml2js = require('xml2js');
const builder = new xml2js.Builder();
const axios = require('axios');
const bodyParser = require('body-parser');
const pdf = require('pdf-parse');
const app = express();
const upload = multer({ dest: 'uploads/' });
const moment = require('moment');
const sql = require('mssql');
const { exec } = require('child_process');

require('dotenv').config();
//const url = 'https://test.registradores.org/xmlpeticion';
//const url = 'http://localhost:3000/xmlpeticion'

const url = process.env.XML_URL;
const port = process.env.PORT;
const instance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false // Desactiva la validación de certificados
    }),
    retry: 0, // Sin reintentos
    timeout: 15000  // Timeout de 5000 ms (5 segundos)
});

const CREDENCIALES = {
    ENTIDAD: process.env.ENTIDAD,
    GRUPO: process.env.GRUPO,
    USUARIO: process.env.USUARIO,
    EMAIL: process.env.EMAIL
};

// Middleware para parsear JSON en las respuestas entrantes

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('xml')) return next();
    bodyParser.raw({ type: '*/*', limit: '100mb' })(req, res, (err) => {
        if (err) return next(err);
        if (!req.body || !Buffer.isBuffer(req.body)) return next();
        const xmlString = req.body.toString('utf8');
        xml2js.parseString(xmlString, { explicitArray: true }, (parseErr, result) => {
            if (parseErr) return next(parseErr);
            req.body = result;
            next();
        });
    });
});


// Servir archivos estÃ¡ticos (HTML, CSS, JS, etc.)
app.use(express.static('public'));

// Configuración para acceder a la BBDD de tasadores
const config = {
    user: process.env.DB_USER,  // Usuario de la base de datos
    password: process.env.DB_PASSWORD,  // Contraseña del usuario
    server: process.env.DB_SERVER,  // Dirección IP y puerto del servidor SQL Server
    port: parseInt(process.env.DB_PORT),  // Puerto de la base de datos
    database: process.env.DB_DATABASE,  // Nombre de la base de datos
    options: {
        encrypt: false,  // Cambiar a true si se usa en producción y requiere cifrado
        enableArithAbort: true
    }
};

// Función para realizar la consulta y llamar a Python
async function modificarDBFConPython(idPeticion, idVersion) {
    try {
        // Crear una nueva solicitud SQL para la consulta `get_For_DBF`
        const queryDBF = `
            SELECT * FROM notassimples.get_For_DBF(@idPeticion, @idVersion)
        `;
        const dbfRequest = new sql.Request();
        dbfRequest.input('idPeticion', sql.Int, idPeticion);
        dbfRequest.input('idVersion', sql.SmallInt, idVersion);

        // Ejecutar la consulta y obtener los datos
        const dbfDataResult = await dbfRequest.query(queryDBF);
        const dbfData = dbfDataResult.recordset[0];

        if (!dbfData) {
            logger.error(`idPeticion ${idPeticion} No se encontraron datos para el archivo DBF.`);
            return;
        }

        // Extraer valores necesarios para la llamada al script Python
        const { IM_ANO_CLA, IM_NUM_TAS, IM_SUP_TAS, IMAGEN, NombreArchivo } = dbfData;

        const queryidDocumento = `
            SELECT notassimples.peticiones_get_idDocumento(@idPeticion, @idVersion) AS idDocumento
        `;

        const idDocumentoRequest = new sql.Request();
        idDocumentoRequest.input('idPeticion', sql.Int, idPeticion);
        idDocumentoRequest.input('idVersion', sql.SmallInt, idVersion);

        // Ejecutar la consulta correctamente con el nombre del objeto adecuado
        const queryidDocumentoResult = await idDocumentoRequest.query(queryidDocumento);
        const idDocumento = queryidDocumentoResult.recordset[0].idDocumento;
        const NombreArchivoDoc = `${idDocumento}.dbf`

        //logger.info(IM_ANO_CLA, IM_NUM_TAS, IM_SUP_TAS, IMAGEN, idDocumento);

        // Llamar al script Python y pasar los argumentos
        exec(`python3 modificar_dbf.py ${IM_ANO_CLA} ${IM_NUM_TAS} ${IM_SUP_TAS} ${IMAGEN} ${NombreArchivoDoc}`,
            (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error al ejecutar el script de Python: ${error.message}`);
                    return;
                }
                if (stderr) {
                    logger.error(`stderr de Python: ${stderr}`);
                    return;
                }
                logger.info(`Salida del script Python: ${stdout}`);
            });

        // Llamada al procedimiento almacenado notassimples.peticiones_peticion_dbf_insert en un bloque try-catch separado
        try {
            const insertRequest = new sql.Request();
            insertRequest.input('idDocumento', sql.Int, idDocumento);
            insertRequest.input('NombreArchivo', sql.VarChar(255), NombreArchivo);

            await insertRequest.query(`
                EXEC notassimples.peticiones_peticion_dbf_insert 
                    @idDocumento, 
                    @NombreArchivo
            `);

            logger.info(`Registro insertado con éxito en peticiones_peticion_dbf_insert para idDocumento: ${idDocumento} y NombreArchivo: ${NombreArchivo}`);
            logger.info(`Ejecutado peticiones_peticion_dbf_insert para idDocumento: ${idDocumento}, NombreArchivo: ${NombreArchivo}`);
        } catch (error) {
            logger.error(`Error al ejecutar peticiones_peticion_dbf_insert: ${error.message}`);
            logger.error(`Error al ejecutar peticiones_peticion_dbf_insert para idDocumento: ${idDocumento} y NombreArchivo: ${NombreArchivo}`);
        }

        // Llamada al procedimiento notassimples.peticiones_historia_new 
        try {
            const comentario = `Generación del archivo DBF: ${NombreArchivo}`;
            const historiaRequest = new sql.Request();


            historiaRequest.input('idPeticion', sql.Int, idPeticion);
            historiaRequest.input('idVersion', sql.SmallInt, idVersion);
            historiaRequest.input('idUsuario', sql.VarChar(20), 'SRVREG'); // Ajusta este valor si es necesario
            historiaRequest.input('idEstado', sql.TinyInt, 5);
            historiaRequest.input('comentario', sql.NVarChar(sql.MAX), comentario);

            await historiaRequest.query(`
                EXEC notassimples.peticiones_historia_new 
                    @idPeticion, 
                    @idVersion, 
                    @idUsuario, 
                    @idEstado, 
                    @comentario
            `);

            logger.info(`Registro de historial insertado con éxito para idPeticion: ${idPeticion}, idVersion: ${idVersion} con el comentario: "${comentario}"`);
            logger.info(`Ejecutado peticiones_historia_new para idPeticion: ${idPeticion}, idVersion: ${idVersion} con comentario: "${comentario}"`);
        } catch (error) {
            logger.error(`Error al ejecutar peticiones_historia_new: ${error.message}`);
            logger.info(`Error al ejecutar peticiones_historia_new para idPeticion: ${idPeticion}, idVersion: ${idVersion} con comentario: "${comentario}"`);
        }

    } catch (err) {
        logger.error('Error al modificar el archivo DBF:', err);
    }
}

// Middleware de autenticación bÃ¡sica
function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Autenticación requerida.');
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        return next(); // Usuario autenticado
    }

    return res.status(401).send('Credenciales incorrectas.');
}

// Aplica autenticación a las rutas administrativas
app.use(['/admin', '/status', '/logs', '/stop', '/restart'], basicAuth);



async function getIdPeticionByIdCorpme(idCorpme) {
    const result = await sql.query`SELECT idPeticion FROM peticiones WHERE idCorpme = ${idCorpme}`;
    return result.recordset.length > 0 ? result.recordset[0].idPeticion : null;
}

async function getIdVersionByIdCorpme(idCorpme) {
    const result = await sql.query`SELECT idVersion FROM peticiones WHERE idCorpme = ${idCorpme}`;
    return result.recordset.length > 0 ? result.recordset[0].idVersion : null;
}

async function getIdUsuarioByIdPeticionAndIdVersion(idPeticion, idVersion) {
    const result = await sql.query`SELECT idUsuario FROM peticiones WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
    return result.recordset.length > 0 ? result.recordset[0].idUsuario : null;
}

// Función para extraer CSV y Huella del PDF
async function extractCodesFromPdf(pdfBuffer) {
    try {
        const data = await pdf(pdfBuffer);
        const pdfText = data.text;

        // Expresiones regulares para CSV y Huella
        const csvRegex = /C\.?S\.?V\.?\s*:\s*([A-Za-z0-9]+)/i;
        const huellaRegex = /Huella\s*:\s*([a-f0-9\-]+)/i;

        // Buscar los códigos CSV y Huella en el texto
        const csvMatch = pdfText.match(csvRegex);
        const huellaMatch = pdfText.match(huellaRegex);

        const csvCode = csvMatch ? csvMatch[1] : null;
        const huellaCode = huellaMatch ? huellaMatch[1] : null;

        return {
            csvCode: csvCode || 'No encontrado',
            huellaCode: huellaCode || 'No encontrado'
        };
    } catch (error) {
        logger.error('Error al parsear el PDF:', error);
        throw error;
    }
}

async function fetchPendingRequests() {
    let resultadosTitular = [];  // Crea un array para almacenar las solicitudes por titular
    let resultadosIDUFIR = [];  // Crea un array para almacenar las solicitudes por IDUFIR
    let resultadosFinca = [];  // Crea un array para almacenar los resultados de finca
    let resultadosReenvio = [];  // Crea un array para almacenar las solicitudes de reenvío

    try {
        await sql.connect(config);
        // idEstado = 1 Pendiente de petición
        const peticiones = await sql.query`SELECT idPeticion, idVersion, idUsuario FROM peticiones WHERE idEstado = 1`;
        // Recorrer cada petición encontrada
        for (let i = 0; i < peticiones.recordset.length; i++) {
            const idPeticion = peticiones.recordset[i].idPeticion;
            const idVersion = peticiones.recordset[i].idVersion;
            const idUsuario = peticiones.recordset[i].idUsuario;

            const datosSolicitud = await sql.query`SELECT * FROM datosSolicitud WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;

            // Si idTipoSolicitud es 1, almacenamos los datos de finca en el array
            if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 1) {
                resultadosFinca.push({
                    codigoRegistro: datosSolicitud.recordset[0].codigoRegistro,
                    municipio: datosSolicitud.recordset[0].municipio,
                    provincia: datosSolicitud.recordset[0].provincia,
                    seccion: datosSolicitud.recordset[0].seccion,
                    finca: datosSolicitud.recordset[0].finca,
                    observaciones: datosSolicitud.recordset[0].observaciones,
                    idPeticion: idPeticion,
                    idVersion: idVersion,
                    idUsuario: idUsuario
                });
            }
            // Si idTipoSolicitud es 2, almacenamos el nifTitular y el idPeticion en el array
            else if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 2) {
                resultadosTitular.push({
                    nifTitular: datosSolicitud.recordset[0].nifTitular,
                    observaciones: datosSolicitud.recordset[0].observaciones,
                    idPeticion: idPeticion,
                    idVersion: idVersion,
                    idUsuario: idUsuario
                });
            }
            // Si idTipoSolicitud es 3, almacenamos el IDUFIR y el idPeticion en el array
            else if (datosSolicitud.recordset.length > 0 && datosSolicitud.recordset[0].idTipoSolicitud === 3) {
                resultadosIDUFIR.push({
                    IDUFIR: datosSolicitud.recordset[0].IDUFIR,
                    observaciones: datosSolicitud.recordset[0].observaciones,
                    idPeticion: idPeticion,
                    idVersion: idVersion,
                    idUsuario: idUsuario
                });
            }
        }
        // idEstado = 6 Pendiente de petición de reenvío
        const peticionesReenvio = await sql.query`SELECT idPeticion, idVersion, idCorpme FROM peticiones WHERE idEstado = 6`;
        // Recorrer cada petición encontrada
        for (let i = 0; i < peticionesReenvio.recordset.length; i++) {
            const idPeticion = peticionesReenvio.recordset[i].idPeticion;
            const idVersion = peticionesReenvio.recordset[i].idVersion;
            const idCorpme = peticionesReenvio.recordset[i].idCorpme;
            resultadosReenvio.push({
                idCorpme: idCorpme,  // Asumiendo que idCorpme estÃ¡ en la tabla peticiones
                idPeticion: idPeticion,
                idVersion: idVersion,
            });

        }

        // Verificar si se encontraron resultados

        if (resultadosFinca.length > 0) {
            logger.info(`Resultados de finca encontrados: ${resultadosFinca}`);
        } else {
            //logger.info("No se encontraron registros válidos para finca o el idTipoSolicitud no es 0.");
        }

        if (resultadosTitular.length > 0) {
            logger.info(`Resultados de titulares encontrados: ${resultadosTitular}`);
        } else {
            // logger.info("No se encontraron registros válidos para titulares o el idTipoSolicitud no es 1.");
        }

        if (resultadosIDUFIR.length > 0) {
            logger.info(`Resultados de IDUFIR encontrados: ${resultadosIDUFIR}`);
        } else {
            //logger.info("No se encontraron registros válidos para IDUFIR o el idTipoSolicitud no es 2.");
        }

        if (resultadosReenvio.length > 0) {
            logger.info(`Resultados de Re-Envio encontrados: ${resultadosReenvio}`);
        } else {
            //logger.info("No se encontraron registros válidos para IDUFIR o el idTipoSolicitud no es 3.");
        }
        return { resultadosTitular, resultadosIDUFIR, resultadosFinca, resultadosReenvio };  // Devolver todos los arrays de resultados
    } catch (err) {
        logger.error('Error en la base de datos en fetchPendingRequests:', err);
        logger.info(`Error en la base de datos en fetchPendingRequests : ${err.message}`);
        throw err;  // Lanzar el error
    } finally {
        await sql.close();  // Asegurar que la conexión se cierre
    }
}

async function sendXMLxTitular(resultados) {
    for (let data of resultados) {

        const { nifTitular, observaciones, idPeticion, idVersion, idUsuario } = data;
        const xml = fs.readFileSync('./xml/peticion_x_titular.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xml);

            // Modificación del XML con los datos del archivo .env
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].entidad[0] = CREDENCIALES.ENTIDAD;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].grupo[0] = CREDENCIALES.GRUPO;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].usuario[0] = CREDENCIALES.USUARIO;

            //parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = CREDENCIALES.EMAIL;

            // Obtener email del usuario de la base de datos con la función  usar valor predeterminado
            await sql.connect(config);
            const result = await sql.query`
                SELECT notassimples.get_email_usuario(${idUsuario}) AS email
            `;

            // Asignar el correo electrónico, o valor predeterminado si es nulo
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = result.recordset[0]?.email || 'joseluis.martin@uah.es';

            parsedXml['corpme-floti'].peticiones[0].peticion[0].titular[0].nif[0] = nifTitular;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].referencia = `RT_${idPeticion}_${idVersion}`;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].observaciones[0] = observaciones;


            const newXml = builder.buildObject(parsedXml);
            const xmlFile1 = `peticion_x_titular_${idPeticion}_${idVersion}.xml`;
            fs.writeFileSync(`./xml_enviados/${xmlFile1}`, newXml);
            logEscritura(logger, 'XML', './xml_enviados/', xmlFile1);

            // Conectar a la base de datos y guardar el XML en la tabla peticiones
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET xml_peticion = ${newXml} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
            logger.info(`XML guardado en la base de datos para idPeticion ${idPeticion} y version ${idVersion}`);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };

            const response = await instance(options);
            if (response.data) {
                logger.info(`Solicitud lanzada a ${url} x Titular y acuse recibido ok para idPeticion ${idPeticion} y version ${idVersion}`);

                const now = new Date();
                const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}-${now.getMilliseconds()}`;

                const fileName = `./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`;

                fs.writeFileSync(fileName, response.data);
                logEscritura(logger, 'Acuse XML', './xml_recibidos/', `acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`);

                const receiptXml = await xml2js.parseStringPromise(response.data);
                handleReceipt(receiptXml, idPeticion, idVersion);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                logger.error('Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID:', idPeticion, 'version:', idVersion);
            } else if (error.response) {
                // El servidor respondió con un código de estado fuera del rango 2xx
                logger.error('Error de respuesta del servidor para ID:', idPeticion, 'version:', idVersion, 'Código de estado:', error.response.status);
            } else if (error.request) {
                // La solicitud fue hecha pero no se recibió respuesta
                logger.error('No se recibió respuesta para la solicitud del ID:', idPeticion, 'version:', idVersion);
            } else {
                // Algo ocurrió al configurar la solicitud que disparó un error
                logger.error('Error configurando la solicitud para ID:', idPeticion, 'version:', idVersion);
            }
            logger.error('Información del error:', error.message);  // Mensaje general del error
            logger.info(`Error al lanzar petición x Titular : ${error.message}`);
        }
    }
}

async function sendXMLxIDUFIR(resultados) {
    for (let data of resultados) {

        const { IDUFIR, observaciones, idPeticion, idVersion, idUsuario } = data;
        const xml = fs.readFileSync('./xml/peticion_x_idufir.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xml);

            // Modificación del XML con los datos del archivo .env
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].entidad[0] = CREDENCIALES.ENTIDAD;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].grupo[0] = CREDENCIALES.GRUPO;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].usuario[0] = CREDENCIALES.USUARIO;

            //parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = CREDENCIALES.EMAIL;

            // Obtener email del usuario de la base de datos con la función  usar valor predeterminado
            await sql.connect(config);
            const result = await sql.query`
                SELECT notassimples.get_email_usuario(${idUsuario}) AS email
            `;

            // Asignar el correo electrónico, o valor predeterminado si es nulo
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = result.recordset[0]?.email || 'joseluis.martin@uah.es';

            parsedXml['corpme-floti'].peticiones[0].peticion[0].idufir[0] = IDUFIR;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].observaciones[0] = observaciones;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].referencia = `RF_${idPeticion}_${idVersion}`;

            const newXml = builder.buildObject(parsedXml);

            const xmlFile2 = `peticion_x_idufir_${idPeticion}_${idVersion}.xml`;
            fs.writeFileSync(`./xml_enviados/${xmlFile2}`, newXml);
            logEscritura(logger, 'XML', './xml_enviados/', xmlFile2);

            // Conectar a la base de datos y guardar el XML en la tabla peticiones
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET xml_peticion = ${newXml} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
            logger.info(`XML guardado en la base de datos para idPeticion ${idPeticion} y version ${idVersion}`);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };

            const response = await instance(options);
            if (response.data) {
                logger.info(`Solicitud lanzada a ${url} x IDUFIR y acuse recibido ok para idPeticion ${idPeticion} y version ${idVersion}`);

                const now = new Date();
                const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}-${now.getMilliseconds()}`;

                const fileName = `./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`;

                fs.writeFileSync(fileName, response.data);
                logEscritura(logger, 'Acuse XML', './xml_recibidos/', `acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`);

                const receiptXml = await xml2js.parseStringPromise(response.data);
                handleReceipt(receiptXml, idPeticion, idVersion);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                logger.error('Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID:', idPeticion, 'version:', idVersion);
            } else if (error.response) {
                logger.error('Error de respuesta del servidor para ID:', idPeticion, 'version:', idVersion, 'Código de estado:', error.response.status);
            } else if (error.request) {
                logger.error('No se recibió respuesta para la solicitud del ID:', idPeticion, 'version:', idVersion);
            } else {
                logger.error('Error configurando la solicitud para ID:', idPeticion, 'version:', idVersion);
            }
            logger.error('Información del error:', error.message);  // Mensaje general del error
            logger.info(`Error al lanzar petición x IDUFIR : ${error.message}`);
        }
    }
}

async function sendXMLxFinca(resultados) {
    for (let data of resultados) {
        // logger.info(data);
        const { codigoRegistro, municipio, provincia, seccion, finca, observaciones, idPeticion, idVersion, idUsuario } = data;
        const xml = fs.readFileSync('./xml/peticion_x_finca.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xml);

            // Modificación del XML con los datos del archivo .env
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].entidad[0] = CREDENCIALES.ENTIDAD;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].grupo[0] = CREDENCIALES.GRUPO;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].usuario[0] = CREDENCIALES.USUARIO;

            // Obtener email del usuario de la base de datos con la función  usar valor predeterminado
            await sql.connect(config);
            const result = await sql.query`
                SELECT notassimples.get_email_usuario(${idUsuario}) AS email
            `;

            // Asignar el correo electrónico, o valor predeterminado si es nulo
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = result.recordset[0]?.email || 'joseluis.martin@uah.es';

            // Convertir los valores a enteros antes de asignarlos
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].registro[0] = parseInt(codigoRegistro, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].municipio[0] = parseInt(municipio, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].provincia[0] = parseInt(provincia, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].seccion[0] = parseInt(seccion, 10);

            // Procesar la variable 'finca' para separar finca y subfinca si es necesario
            let fincaValue, subfincaValue;

            // Verificar si la cadena contiene un separador '/'
            if (finca.includes('/')) {
                const [firstPart, secondPart] = finca.split('/');
                fincaValue = parseInt(firstPart, 10); // Convertir la primera parte a un nÃºmero entero
                subfincaValue = secondPart; // Mantener la segunda parte como cadena
            } else {
                fincaValue = parseInt(finca, 10); // Si no hay '/', usar el valor como entero
                subfincaValue = null; // No hay subfinca
            }

            // Asignar los valores procesados al XML
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].finca[0] = fincaValue;

            if (subfincaValue) {
                parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].subfinca = [subfincaValue];
            }

            parsedXml['corpme-floti'].peticiones[0].peticion[0].observaciones[0] = observaciones;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].referencia = `RF_${idPeticion}_${idVersion}`;

            const newXml = builder.buildObject(parsedXml);

            const xmlFile3 = `peticion_x_finca_${idPeticion}_${idVersion}.xml`;
            fs.writeFileSync(`./xml_enviados/${xmlFile3}`, newXml);
            logEscritura(logger, 'XML', './xml_enviados/', xmlFile3);

            // Conectar a la base de datos y guardar el XML en la tabla peticiones
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET xml_peticion = ${newXml} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
            logger.info(`XML guardado en la base de datos para idPeticion ${idPeticion} y version ${idVersion}`);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };

            const response = await instance(options);
            if (response.data) {
                logger.info(`Solicitud lanÃ§ada a ${url} x Finca y acuse recibido ok para idPeticion ${idPeticion} y version ${idVersion}`);

                const now = new Date();
                const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}-${now.getMilliseconds()}`;

                const fileName = `./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`;

                fs.writeFileSync(fileName, response.data);
                logEscritura(logger, 'Acuse XML', './xml_recibidos/', `acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`);

                const receiptXml = await xml2js.parseStringPromise(response.data);
                handleReceipt(receiptXml, idPeticion, idVersion);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                logger.error('Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID:', idPeticion, 'version:', idVersion);
            } else if (error.response) {
                logger.error('Error de respuesta del servidor para ID:', idPeticion, 'version:', idVersion, 'Código de estado:', error.response.status);
            } else if (error.request) {
                logger.error('No se recibió respuesta para la solicitud del ID:', idPeticion, 'version:', idVersion);
            } else {
                logger.error('Error configurando la solicitud para ID:', idPeticion, 'version:', idVersion);
            }
            logger.error('Información del error:', error.message);  // Mensaje general del error
            logger.info(`Error al lanzar petición x Finca : ${error.message}`);
        }
    }
}

async function sendXMLReenvio(resultados) {
    for (let data of resultados) {
        const { idCorpme, idPeticion, idVersion } = data;
        const xmlTemplate = fs.readFileSync('./xml/plantilla_reenvio.xml', 'utf-8');

        try {
            const parsedXml = await xml2js.parseStringPromise(xmlTemplate);
            parsedXml['corpme-floti'].reenvio[0].identificador[0] = idCorpme;

            const newXml = builder.buildObject(parsedXml);

            const xmlFile4 = `peticion_reenvio_${idPeticion}_${idVersion}.xml`;
            fs.writeFileSync(`./xml_enviados/${xmlFile4}`, newXml);
            logEscritura(logger, 'XML', './xml_enviados/', xmlFile4);

            // Conectar a la base de datos y guardar el XML en la tabla peticiones
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET xml_peticion = ${newXml} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
            logger.info(`XML guardado en la base de datos para idPeticion ${idPeticion} y version ${idVersion}`);

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };

            const response = await instance(options);
            if (response.data) {
                logger.info(`Solicitud de reenvío lanzada a ${url} y acuse recibido ok para idPeticion ${idPeticion} y version ${idVersion}`);
                const acuseFile = `acuseRecibido_${idPeticion}_${idVersion}.xml`;
                fs.writeFileSync(`./xml_recibidos/${acuseFile}`, response.data);
                logEscritura(logger, 'Acuse XML', './xml_recibidos/', acuseFile);
                const receiptXml = await xml2js.parseStringPromise(response.data);
                if (receiptXml && receiptXml['corpme-floti'] && receiptXml['corpme-floti'].respuesta && receiptXml['corpme-floti'].respuesta.length > 0) {
                    await processReenvioCorpmeFloti(receiptXml, idPeticion, idVersion);
                }
                // Si no existe "respuesta" pero sÃ­ existe el nodo "error", se procesa como error
                else if (receiptXml && receiptXml['corpme-floti'] && receiptXml['corpme-floti'].error && receiptXml['corpme-floti'].error.length > 0) {
                    const errorNode = receiptXml['corpme-floti'].error[0];
                    const codigoError = errorNode['$'] && errorNode['$'].codigo ? errorNode['$'].codigo : null;
                    const errorText = errorNode['_'] || 'Sin información adicional';

                    const xmlStringError = builder.buildObject(receiptXml);
                    try {

                        await sql.connect(config);
                        const queryUpdateXml = `UPDATE peticiones SET xml_respuesta = @xmlRespuesta  WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                        const requestUpdateXml = new sql.Request();
                        requestUpdateXml.input('xmlRespuesta', sql.NVarChar(sql.MAX), xmlStringError);
                        requestUpdateXml.input('idCorpme', sql.VarChar(50), idCorpme);
                        requestUpdateXml.input('idPeticion', sql.Int, idPeticion);
                        requestUpdateXml.input('idVersion', sql.SmallInt, idVersion);
                        await requestUpdateXml.query(queryUpdateXml);


                        // Actualizar la petición asignando el estado 7 y registrando el código de error
                        const query = `UPDATE peticiones SET IdEstado = 7, idRespuesta = @codigoError WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                        const request = new sql.Request();
                        request.input('codigoError', sql.Int, codigoError);
                        request.input('idCorpme', sql.VarChar(50), idCorpme);
                        request.input('idPeticion', sql.Int, idPeticion);
                        request.input('idVersion', sql.SmallInt, idVersion);
                        await request.query(query);

                        // Registrar en la tabla de historial utilizando el texto del error como comentario
                        const comentario = errorText;
                        const idUsuario = "CORPME";
                        const idEstado = 7;
                        const queryHistoria = `
                            EXEC notassimples.peticiones_historia_new
                                @idPeticion,
                                @idVersion,
                                @idUsuario,
                                @idEstado,
                                @comentario
                        `;
                        const requestHistoria = new sql.Request();
                        requestHistoria.input('idPeticion', sql.Int, idPeticion);
                        requestHistoria.input('idVersion', sql.SmallInt, idVersion);
                        requestHistoria.input('idUsuario', sql.VarChar(20), idUsuario);
                        requestHistoria.input('idEstado', sql.TinyInt, idEstado);
                        requestHistoria.input('comentario', sql.NVarChar(sql.MAX), comentario);
                        await requestHistoria.query(queryHistoria);
                        logger.info(`Recibida respuesta de error para solicitud de reenvío: idCorpme: ${idCorpme}, idPeticion: ${idPeticion} e idVersion: ${idVersion}. ${comentario}`);
                    } catch (err) {
                        logger.error(`(Reenvio) idPeticion: ${idPeticion} Error al procesar el error en el XML: ${err}`);
                    }
                }
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                logger.error(`Timeout: La solicitud fue abortada debido a un exceso de tiempo de espera para el ID: ${idPeticion} version:${idVersion}`);
            } else if (error.response) {
                logger.error(`Error de respuesta del servidor para ID: ${idPeticion} version:, ${idVersion}, Código de estado: ${error.response.status} `);
            } else if (error.request) {
                logger.error(`No se recibió respuesta para la solicitud del ID:${idPeticion}, version: ${idVersion}` );
            } else {
                logger.error(`Error configurando la solicitud para ID: ${idPeticion} version ${idVersion} `);
            }
            logger.error(`Información del error en idPeticion: ${idPeticion} : ${error.message}`);  // Mensaje general del error
            logger.info(`Error al lanzar petición de reenvío : ${error.message}`);
        }
    }
}

async function handleReceipt(receipt, idPeticion, idVersion) {
    // Suponemos que estamos tratando con un solo acuse
    let comentario = ''; // Se inicializa el comentario con una cadena vacia
    let idUsuario = ''; // Se inicializa el idUsuario como una cadena vacÃ­a
    let idEstado = 2; // Por defecto 2, que indica éxito

    try {
        // Se conecta a la base de datos para obtener el idUsuario de la tabla 'peticiones'
        await sql.connect(config);
        const result = await sql.query`SELECT idUsuario FROM peticiones WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;

        if (result.recordset.length > 0) {
            idUsuario = "CORPME";
        } else {
            logger.info(`No se encontró un registro para idPeticion ${idPeticion} y idVersion ${idVersion}`);
            throw new Error(`No se encontró un registro para idPeticion ${idPeticion} y idVersion ${idVersion}`);
        }

        // Se verifica si la respuesta general contiene un error
        if (receipt && receipt['corpme-floti'] && receipt['corpme-floti'].error) {
            // Se extrae el código de error
            const codigo = receipt['corpme-floti'].error[0]['$'].codigo;
            logger.info("codigo,", codigo);
            const mensaje = receipt['corpme-floti'].error[0]['_'];
            logger.error(`Error general en el XML recibido para ID ${idPeticion} ${idVersion}: ${mensaje} (Código ${codigo})`);
            idEstado = 3; // Se cambia el estado a 3 (indica error)
            comentario = `Petición recibida por Registradores KO: idError: ${codigo} | ${mensaje}`;

            // Se Conecta a la base de datos y se actualiza el estado y el código de error
            await sql.connect(config);
            await sql.query`UPDATE peticiones SET idEstado = 3, idError = ${codigo} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
            logger.info(`Estado actualizado a 3 y error registrado para idPeticion ${idPeticion} y version ${idVersion}`);

        } else if (receipt && receipt['corpme-floti'] && receipt['corpme-floti']['acuses'] && receipt['corpme-floti']['acuses'][0]['acuse']) {
            // Se accede al objeto 'acuse'
            const acuse = receipt['corpme-floti']['acuses'][0]['acuse'][0];

            // Se verifica si el acuse contiene un error
            if (acuse.error) {
                const codigo = acuse.error[0]['$'].codigo;
                logger.info("Codigo", codigo);
                const mensaje = acuse.error[0]['_'];
                logger.error(`Error especí­fico en el acuse para ID ${idPeticion} ${idVersion}: ${mensaje} (Codigo ${codigo})`);

                idEstado = 3; // Se cambia el estado a 3 por error especí­fico
                comentario = `Petición recibida por Registradores KO: idError: ${codigo} | ${mensaje}`;

                // Se conecta a la base de datos y se actualiza el estado y el código de error

                await sql.query`UPDATE peticiones SET idEstado = 3, idError = ${codigo} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
                logger.info(`Estado actualizado a 3 y error registrado para idPeticion ${idPeticion} y version ${idVersion}`);

            } else {
                const acuse = receipt['corpme-floti']['acuses'][0]['acuse'][0];
                try {
                    await sql.query`UPDATE peticiones SET idEstado = 2, idError = NULL WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
                    logger.info(`Estado actualizado a 2 para idPeticion ${idPeticion} y version ${idVersion}`);

                    // Se procesa cada identificador (si hay varios, serÃ­a acuse['identificador'].forEach(...))
                    if (acuse['identificador']) {
                        for (const identificador of acuse['identificador']) {
                            await sql.query`UPDATE peticiones SET idCorpme = ${identificador} WHERE idPeticion = ${idPeticion} AND idVersion = ${idVersion}`;
                            logger.info(`Identificador actualizado a ${identificador} para idPeticion ${idPeticion} y version ${idVersion}`);
                            comentario = `Petición recibida por Registradores OK: idCorpme = ${identificador}`;
                        }
                    }
                } catch (err) {
                    logger.error(`Error al realizar operaciones en la base de datos: ${err}`);
                }
            }
        }

        // Se llama al procedure después de manejar el receipt

        const query = `
            EXEC notassimples.peticiones_historia_new
                @idPeticion,
                @idVersion,
                @idUsuario,
                @idEstado,
                @comentario
        `;
        const request = new sql.Request();

        request.input('idPeticion', sql.Int, idPeticion);
        request.input('idVersion', sql.SmallInt, idVersion);
        request.input('idUsuario', sql.VarChar(20), idUsuario);
        request.input('idEstado', sql.TinyInt, idEstado);
        request.input('comentario', sql.NVarChar(sql.MAX), comentario);
        await request.query(query);
        logger.info(`Procedure notassimples.peticiones_historia_new ejecutado para idPeticion ${idPeticion} y version ${idVersion}`);

    } catch (err) {
        logger.error('[handleReceipt] Error al realizar operaciones en la base de datos:', err);

    } finally {
        await sql.close();
    }
}

// Función para procesar el XML de respuesta a una solicitud de reenvío
async function processReenvioCorpmeFloti(xmlData, idPeticion, idVersion) {
    const corpmeFloti = xmlData['corpme-floti'];
    if (corpmeFloti && corpmeFloti.respuesta && corpmeFloti.respuesta.length > 0) {
        const respuesta = corpmeFloti.respuesta[0];
        const identificador = respuesta.identificador ? respuesta.identificador[0] : null;
        const informacion = respuesta.informacion ? respuesta.informacion[0] : null;

        // Accedemos al tipo-respuesta y su código
        const tipoRespuesta = respuesta['tipo-respuesta'] ? respuesta['tipo-respuesta'][0] : null;
        const codigoTipoRespuesta = tipoRespuesta ? tipoRespuesta['$'].codigo : null;
        const textoTipoRespuesta = tipoRespuesta ? tipoRespuesta['_'] : null;

        // Extraer referencia que contiene RF_idPeticion_idVersion
        const referencia = respuesta.referencia ? respuesta.referencia[0] : null;


        // Hacemos una copia del XML para modificarla antes de guardarla en la base de datos
        let xmlDataSinPdfNiFirma = JSON.parse(JSON.stringify(xmlData)); // Copia profunda del objeto original


        // Eliminar el campo <ds:signature> dentro de corpme-floti si existe en la copia del XML
        if (xmlDataSinPdfNiFirma['corpme-floti'] && xmlDataSinPdfNiFirma['corpme-floti']['ds:Signature']) {
            delete xmlDataSinPdfNiFirma['corpme-floti']['ds:Signature'];
        }

        // Eliminar el fichero PDF incrustado en la copia del XML
        if (xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion &&
            xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion[0].fichero) {
            delete xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion[0].fichero;
        }

        // Guardar el XML sin el PDF incrustado y sin el campo ds:signature en la tabla peticiones
        try {
            await sql.connect(config);

            // Se convierte el objeto modificado de vuelta a formato XML
            const xmlStringSinPdfNiFirma = builder.buildObject(xmlDataSinPdfNiFirma);

            const queryGuardarXml = `UPDATE peticiones SET xml_respuesta = @xmlRespuesta WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
            const requestGuardarXml = new sql.Request();
            requestGuardarXml.input('xmlRespuesta', sql.NVarChar(sql.MAX), xmlStringSinPdfNiFirma);
            requestGuardarXml.input('idCorpme', sql.VarChar(50), identificador);
            requestGuardarXml.input('idPeticion', sql.Int, idPeticion);
            requestGuardarXml.input('idVersion', sql.SmallInt, idVersion);
            await requestGuardarXml.query(queryGuardarXml);

            logger.info(`[processReenvioCorpmeFloti]  XML sin PDF y sin firma guardado en la base de datos para idCorpme: ${identificador}`);

        } catch (err) {
             // Convierte TODO el objeto de error a un string visible
            const detalleError = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
            
            logger.error(`[processReenvioCorpmeFloti] Error al guardar el XML. Detalles: ${detalleError}`);

            if (!res.headersSent) res.status(500).send('Error al guardar el XML en la base de datos');
            return;
        }

        const xmlString = builder.buildObject(xmlData);

        const respuestaFile = `respuestaRecibidaReenvio_${idPeticion}_${idVersion}_${identificador}.xml`;
        logEscritura(logger, 'XML Respuesta', './xml/', respuestaFile);
        fs.writeFile(`./xml/${respuestaFile}`, xmlString, (err) => {
            if (err) {
                logger.error(`[processReenvioCorpmeFloti]  (Reenvio) Error al guardar el archivo XML:${err}`);
                res.status(500).send('(Reenvio) Error al guardar el archivo XML');
                return;
            }
            logger.info(`[processReenvioCorpmeFloti] Archivo XML de respuesta a reenvío guardado idPeticion: ${idPeticion} | idVersion: ${idVersion} | idCorpme ${identificador}`);
        });

        if (!tipoRespuesta) {
            res.status(400).send('(Reenvio) Tipo de respuesta no encontrado');
            logger.info(`[processReenvioCorpmeFloti] (Reenvio) Tipo de respuesta no encontrado al tramitar una respuesta Floti idPeticion: ${idPeticion} | idVersion: ${idVersion}`);
            return;
        }

        logger.info(`CodigoRespuesta ${codigoTipoRespuesta} ${textoTipoRespuesta}`);

        if (codigoTipoRespuesta === '11') {
            // Si tipo-respuesta es 11, es la nota simple reenviada
            let ficheroPdfBase64;
            if (informacion && informacion.fichero && informacion.fichero.length > 0) {
                ficheroPdfBase64 = informacion.fichero[0]['_'];

                try {
                    // Conexión a la base de datos
                    await sql.connect(config);
                    const query = `UPDATE peticiones SET pdf = @pdf, IdEstado = 5, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                    const request = new sql.Request();
                    const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');
                    request.input('pdf', sql.VarBinary(sql.MAX), pdfBuffer);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    request.input('idPeticion', sql.Int, idPeticion);
                    request.input('idVersion', sql.SmallInt, idVersion);
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    await request.query(query);

                    logger.info('[processReenvioCorpmeFloti] (Reenvio sí­ncrono) PDF guardado en la base de datos exitosamente.');

                    const comentario = 'Recepción de NS por GT';
                    const idUsuario = "CORPME";
                    const idEstado = 5;

                    const queryHistoria = `
                    EXEC notassimples.peticiones_historia_new
                        @idPeticion,
                        @idVersion,
                        @idUsuario,
                        @idEstado,
                        @comentario
                    `;

                    const requestHistoria = new sql.Request();

                    requestHistoria.input('idPeticion', sql.Int, idPeticion);
                    requestHistoria.input('idVersion', sql.SmallInt, idVersion);
                    requestHistoria.input('idUsuario', sql.VarChar(20), idUsuario);
                    requestHistoria.input('idEstado', sql.TinyInt, idEstado);
                    requestHistoria.input('comentario', sql.NVarChar(sql.MAX), comentario);

                    await requestHistoria.query(queryHistoria);

                    logger.info(`[processReenvioCorpmeFloti] PDF de nota simple reenviada guardado en la base de datos exitosamente para idCorpme: ${identificador}, idPeticion: ${idPeticion} e idVersion: ${idVersion}`);


                    // Leer y enviar XML de confirmación. 
                    // const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    // res.set('Content-Type', 'text/xml');
                    // res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processReenvioCorpmeFloti] Error al guardar el PDF en la base de datos: ${err}`);
                    // if (!res.headersSent) res.status(500).send('Error al guardar el PDF en la base de datos');
                    return;
                }
            }
        } else {
            // Notas denegadas 
            if (codigoTipoRespuesta === '12') {
                // Nota simple reenviada negativa
                try {
                    await sql.connect(config);
                    // Guardar tipo-respuesta en la tabla peticiones
                    const query = `UPDATE peticiones SET IdEstado = 7, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme`;
                    const request = new sql.Request();
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    await request.query(query);

                    // Obtener idPeticion y idVersion
                    const idPeticion = await getIdPeticionByIdCorpme(identificador);
                    const idVersion = await getIdVersionByIdCorpme(identificador);

                    if (idPeticion && idVersion) {
                        // Llamar al procedimiento con el comentario basado en informacion.texto
                        const comentario = informacion && informacion.texto ? informacion.texto[0] : 'Sin información adicional';
                        //const idUsuario = await getIdUsuarioByIdPeticionAndIdVersion(idPeticion, idVersion);
                        const idUsuario = "CORPME";
                        const idEstado = 7;

                        const query = `
                            EXEC notassimples.peticiones_historia_new
                                @idPeticion,
                                @idVersion,
                                @idUsuario,
                                @idEstado,
                                @comentario
                            `;

                        const request = new sql.Request();

                        request.input('idPeticion', sql.Int, idPeticion);
                        request.input('idVersion', sql.SmallInt, idVersion);
                        request.input('idUsuario', sql.VarChar(20), idUsuario);
                        request.input('idEstado', sql.TinyInt, idEstado);
                        request.input('comentario', sql.NVarChar(sql.MAX), comentario);

                        await request.query(query);
                        logger.info(`[processReenvioCorpmeFloti] Recibida respuesta negativa para solicitud de reenvío: ${identificador}, idPeticion: ${idPeticion} e idVersion: ${idVersion}. ${comentario}`);
                    } else {
                        logger.error(`[processReenvioCorpmeFloti] (Reenvio) No se encontraron idPeticion o idVersion asociados con el identificador corpme`);
                    }

                    // Enviar confirmación sin el procesamiento del PDF
                    //const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    //res.set('Content-Type', 'text/xml');
                    //res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processReenvioCorpmeFloti] (Reenvio) Error al guardar el tipo-respuesta en la base de datos: ${err}`);
                    //if (!res.headersSent) res.status(500).send('Error al procesar la respuesta');
                }
            } else {
                try {
                    await sql.connect(config);
                    // Guardar tipo-respuesta en la tabla peticiones
                    const query = `UPDATE peticiones SET IdEstado = 7, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                    const request = new sql.Request();
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    request.input('idPeticion', sql.Int, idPeticion);
                    request.input('idVersion', sql.SmallInt, idVersion);
                    await request.query(query);


                    // Llamar al procedimiento con el comentario basado en informacion.texto
                    let textoIntermedio;
                    textoIntermedio = 'Desconocido';

                    const textoTipoRespuesta = informacion && informacion.texto ? informacion.texto[0] : 'Sin información adicional';
                    const comentario = `Petición denegada por Registradores: idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta}`;
                    const idUsuario = "CORPME";
                    const idEstado = 4;

                    const queryHistory = `
                        EXEC notassimples.peticiones_historia_new
                            @idPeticion,
                            @idVersion,
                            @idUsuario,
                            @idEstado,
                            @comentario
                        `;

                    const requestHistory = new sql.Request();

                    requestHistory.input('idPeticion', sql.Int, idPeticion);
                    requestHistory.input('idVersion', sql.SmallInt, idVersion);
                    requestHistory.input('idUsuario', sql.VarChar(20), idUsuario);
                    requestHistory.input('idEstado', sql.TinyInt, idEstado);
                    requestHistory.input('comentario', sql.NVarChar(sql.MAX), comentario);

                    await requestHistory.query(queryHistory);
                    logger.info(`[processReenvioCorpmeFloti] Petición reenvío denegada por Registradores para solicitud de reenvío: idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta} | idCorpme: ${identificador} | idPeticion: ${idPeticion} | idVersion:${idPeticion}.`);


                    // Enviar confirmación sin el procesamiento del PDF
                    // const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    // res.set('Content-Type', 'text/xml');
                    // res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processReenvioCorpmeFloti] (reenvío) Error al guardar el tipo-respuesta en la base de datos: ${err}`);
                    //if (!res.headersSent) res.status(500).send('Error al procesar la respuesta');
                }
            }
        }
    } else {
        //res.status(400).send('(reenvío) Formato de XML inválido o datos faltantes');
        logger.info(`[processReenvioCorpmeFloti] (reenvío) Formato de XML inválido o datos faltantes`);
    }
}

// Ruta principal para servir la pÃ¡gina HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

// Ruta principal para servir la pÃ¡gina de administración
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/admin.html'));
});

// Ruta para ver el estado del servidor
app.get('/status', (req, res) => {
    const serverStatus = {
        status: "running",
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version
    };
    res.json(serverStatus);
});

// Ruta para manejar logs con paginación y filtro por fecha
app.get('/logs', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const linesPerPage = parseInt(req.query.limit) || 100;

    const requestedDate = req.query.date ? moment(req.query.date, 'YYYY-MM-DD') : moment();

    if (!requestedDate.isValid()) {
        return res.status(400).send('Formato de fecha inválido. Utilice el formato YYYY-MM-DD.');
    }

    const logFileName = `app_${requestedDate.format('DD_MM_YYYY')}.log`;
    const logFilePath = path.join(__dirname, 'logs', logFileName);

    try {
        const logContent = fs.readFileSync(logFilePath, 'utf8');
        const logLines = logContent.split('\n').filter(Boolean);

        const totalLines = logLines.length;
        const totalPages = Math.ceil(totalLines / linesPerPage);

        if (totalLines === 0) {
            return res.json({
                page: 1,
                totalPages: 1,
                logs: null,
                date: requestedDate.format('YYYY-MM-DD'),
                message: 'No hay registros disponibles en esta fecha'
            });
        }

        if (page > totalPages) {
            return res.status(404).send('Página no encontrada');
        }

        const startLine = (page - 1) * linesPerPage;
        const endLine = Math.min(startLine + linesPerPage, totalLines);

        const logsToShow = logLines.slice(startLine, endLine).join('\n');

        res.json({
            page: page,
            totalPages: totalPages,
            logs: logsToShow,
            date: requestedDate.format('YYYY-MM-DD')
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.json({
                page: 1,
                totalPages: 1,
                logs: null,
                date: requestedDate.format('YYYY-MM-DD'),
                message: 'No hay registros disponibles en esta fecha'
            });
        }
        logger.error(`Error al leer el archivo de logs: ${error.message}`);
        res.status(500).send('Error al leer el archivo de logs');
    }
});

// Ruta para métricas de logs de los últimos 7 días
app.get('/logs/metrics', (req, res) => {
    const metrics = [];

    for (let i = 6; i >= 0; i--) {
        const date = moment().subtract(i, 'days');
        const logFileName = `app_${date.format('DD_MM_YYYY')}.log`;
        const logFilePath = path.join(__dirname, 'logs', logFileName);

        let exists = false;
        let totalLines = 0;
        let errors = 0;
        let warnings = 0;
        let pythonExec = 0;
        let peticionesEnviadas = 0;
        let acusesRecibidos = 0;
        let peticionesOK = 0;
        let peticionesError = 0;
        let ciclosFetch = 0;

        try {
            const content = fs.readFileSync(logFilePath, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            exists = true;
            totalLines = lines.length;

            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    const level = entry.level || 0;
                    const msg = entry.msg || '';

                    if (level >= 50) errors++;
                    if (level === 40) warnings++;
                    if (msg.includes('[PYTHON]')) pythonExec++;
                    if (/Solicitud.*lanzada.*y acuse recibido/.test(msg)) peticionesEnviadas++;
                    if (msg.includes('Escribiendo archivo Acuse XML')) acusesRecibidos++;
                    if (msg.includes('Estado actualizado a 2')) peticionesOK++;
                    if (/Estado actualizado a [347]/.test(msg)) peticionesError++;
                    if (msg.includes('Ejecutando ciclo de fetchPendingRequests')) ciclosFetch++;
                } catch (e) { /* línea no es JSON válido */ }
            }
        } catch (e) { /* archivo no existe */ }

        metrics.push({
            date: date.format('YYYY-MM-DD'),
            totalLines,
            errors,
            warnings,
            pythonExec,
            peticionesEnviadas,
            acusesRecibidos,
            peticionesOK,
            peticionesError,
            ciclosFetch,
            exists
        });
    }

    res.json(metrics);
});

// Ruta para obtener las estadisticas de peticiones
app.get('/stats', async (req, res) => {
    try {
        await sql.connect(config);

        const query = `
            SELECT idEstado, COUNT(*) AS count
            FROM peticiones
            WHERE idEstado IN (2, 4, 5, 8)
            GROUP BY idEstado
        `;

        const result = await sql.query(query);
        const stats = {
            enEspera: 0,
            respondidas: 0,
            denegadas: 0,
            anuladas: 0,
        };

        // Mapear los resultados a los valores especí­ficos
        result.recordset.forEach(row => {
            switch (row.idEstado) {
                case 2:
                    stats.enEspera = row.count;
                    break;
                case 5:
                    stats.respondidas = row.count;
                    break;
                case 4:
                    stats.denegadas = row.count;
                    break;
                case 8:
                    stats.anuladas = row.count;
                    break;
            }
        });

        res.json(stats);
    } catch (error) {
        logger.error(`[GET stats] Error al obtener estadí­sticas de peticiones: ${error}`);
        res.status(500).send('Error al obtener estadísticas de peticiones');
    } finally {
        await sql.close();
    }
});
// Ruta para DBFs no generados
app.get('/procesar-peticiones-dbfs', async (req, res) => {
    try {
        logger.info(`[GET procesar-peticiones-dbfs]  registradores_peticiones_pendientes ejecutando ...`);

        await sql.connect(config);

        // Consulta SQL para obtener solo las primeras 10 peticiones pendientes
        const query = `EXEC notassimples.registradores_peticiones_pendientes`;

        const result = await sql.query(query);
        const peticiones = result.recordset;

        if (peticiones.length === 0) {
            res.status(200).send('No hay peticiones pendientes para procesar.');
            return;
        }
        logger.info(`[GET procesar-peticiones-dbfs] registradores_peticiones_pendientes ejecutado con éxito ... ${peticiones.length} peticiones`);

        // Iterar sobre los primeros 10 registros y ejecutar modificarDBFConPython
        for (const peticion of peticiones) {
            const { idPeticion, idVersion } = peticion;
            try {
                await modificarDBFConPython(idPeticion, idVersion);
                logger.info(`[GET procesar-peticiones-dbfs]  modificarDBFConPython ejecutado con éxito para idPeticion: ${idPeticion}, idVersion: ${idVersion}`);

            } catch (error) {
                logger.error(`[GET procesar-peticiones-dbfs]  Error al procesar modificarDBFConPython para idPeticion: ${idPeticion}, idVersion: ${idVersion}:`, error);
            }
        }

        res.status(200).send('Peticiones procesadas correctamente.');
    } catch (error) {
        logger.error(`[GET procesar-peticiones-dbfs]  Error al ejecutar la consulta o al conectar a la base de datos: ${error.message}`);
        res.status(500).send('Error al procesar las peticiones.');
    } finally {
        await sql.close();
    }
});

// Ruta para manejar solicitudes POST en /spnts
app.post('/spnts', async (req, res) => {
    try {
        const xmlData = req.body;

        // Verificar el tipo de XML y procesarlo en consecuencia
        if (xmlData['corpme-floti']) {
            await processCorpmeFloti(xmlData, res);
            if (!res.headersSent) res.status(200).send('Procesado');
        } else if (xmlData['corpme-floti-facturacion']) {
            await processCorpmeFlotiFacturacion(xmlData, res);
            if (!res.headersSent) res.status(200).send('Procesado en facturacion');
        } else {
            res.status(400).send('Formato de XML inválido o datos faltantes');
            logger.info(`[POST spnts] Recibida una respuesta con Formato de XML inválido o datos faltantes`);
        }

    } catch (error) {
        logger.error(error);
        if (!res.headersSent) res.status(500).send('Error al procesar la respuesta');
        logger.info(`[POST spnts] Error al procesar una respuesta: ${error}`);
    }
});

// Función para procesar el XML de tipo 'corpme-floti'
async function processCorpmeFloti(xmlData, res) {
    const corpmeFloti = xmlData['corpme-floti'];
    if (corpmeFloti && corpmeFloti.respuesta && corpmeFloti.respuesta.length > 0) {
        const respuesta = corpmeFloti.respuesta[0];
        const identificador = respuesta.identificador ? respuesta.identificador[0] : null;
        const informacion = respuesta.informacion ? respuesta.informacion[0] : null;

        // Accedemos al tipo-respuesta y su código
        const tipoRespuesta = respuesta['tipo-respuesta'] ? respuesta['tipo-respuesta'][0] : null;
        const codigoTipoRespuesta = tipoRespuesta ? tipoRespuesta['$'].codigo : null;
        const textoTipoRespuesta = tipoRespuesta ? tipoRespuesta['_'] : null;

        // Hacemos una copia del XML para modificarla antes de guardarla en la base de datos
        let xmlDataSinPdfNiFirma = JSON.parse(JSON.stringify(xmlData)); // Copia profunda del objeto original


        // Eliminar el campo <ds:signature> dentro de corpme-floti si existe en la copia del XML
        if (xmlDataSinPdfNiFirma['corpme-floti'] && xmlDataSinPdfNiFirma['corpme-floti']['ds:signature']) {
            delete xmlDataSinPdfNiFirma['corpme-floti']['ds:signature'];
        }

        // Eliminar el fichero PDF incrustado en la copia del XML
        if (xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion &&
            xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion[0].fichero) {
            delete xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion[0].fichero;
        }

        // Guardar el XML sin el PDF incrustado y sin el campo ds:signature en la tabla peticiones
        try {
            await sql.connect(config);

            // Se convierte el objeto modificado de vuelta a formato XML
            const xmlStringSinPdfNiFirma = builder.buildObject(xmlDataSinPdfNiFirma);

            const queryGuardarXml = `UPDATE peticiones SET xml_respuesta = @xmlRespuesta WHERE idCorpme = @idCorpme`;
            const requestGuardarXml = new sql.Request();

            requestGuardarXml.input('xmlRespuesta', sql.NVarChar(sql.MAX), xmlStringSinPdfNiFirma.substring(0,1999));
            requestGuardarXml.input('idCorpme', sql.VarChar(50), identificador);
            logger.info(`[processCorpmeFloti] Longitud del XML a guardar: ${xmlData.length} caracteres`);

            await requestGuardarXml.query(queryGuardarXml);

            logger.info(`[processCorpmeFloti] XML sin PDF y sin firma guardado en la base de datos para idCorpme: ${identificador}`);

        } catch (err) {
            // Convierte TODO el objeto de error a un string visible
            const detalleError = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
            
            logger.error(`[processCorpmeFloti] Error al guardar el XML. Detalles:id :${identificador} ${detalleError}`);

            if (!res.headersSent) res.status(500).send('Error al guardar el XML en la base de datos');
            return;
        }

        // Obtener idPeticion y idVersion
        await sql.connect(config);
        const idPeticion = await getIdPeticionByIdCorpme(identificador);
        const idVersion = await getIdVersionByIdCorpme(identificador);

        if (!tipoRespuesta) {
            res.status(400).send('Tipo de respuesta no encontrado');
            logger.info(`[processCorpmeFloti] Tipo de respuesta no encontrado al tramitar una respuesta Floti`);
            return;
        }

        logger.info(`[processCorpmeFloti] codigoRespuesta ${codigoTipoRespuesta}´, textoTipoRespuesta ${textoTipoRespuesta}`);

        // Si tipo-respuesta es 1, es la nota simple solicitada

        if (codigoTipoRespuesta === '1') {
            let ficheroPdfBase64;
            if (informacion && informacion.fichero && informacion.fichero.length > 0) {
                ficheroPdfBase64 = informacion.fichero[0]['_'];

                try {
                    // Conexión a la base de datos
                    await sql.connect(config);
                    const query = `UPDATE peticiones SET pdf = @pdf, IdEstado = 5, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme`;
                    const request = new sql.Request();
                    const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');

                    // Extraer CSV y Huella del PDF
                    const { csvCode, huellaCode } = await extractCodesFromPdf(pdfBuffer);
                    logger.info('CSV encontrado:', csvCode);
                    logger.info('Huella encontrada:', huellaCode);

                    request.input('pdf', sql.VarBinary(sql.MAX), pdfBuffer);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    await request.query(query);

                    logger.info(`[processCorpmeFloti] PDF guardado en la base de datos exitosamente. idCorpme: ${identificador}`);

                    // Se llama al procedure notassimples.peticiones_historia_new
                    const idPeticion = await getIdPeticionByIdCorpme(identificador);  // Función para obtener idPeticion
                    const idVersion = await getIdVersionByIdCorpme(identificador);    // Función para obtener idVersion


                    if (idPeticion && idVersion) {
                        const comentario = `Recepción de NS por GT: CSV: ${csvCode} | Huella: ${huellaCode} `;
                        //const idUsuario = await getIdUsuarioByIdPeticionAndIdVersion(idPeticion, idVersion); // Obtén el idUsuario de la tabla
                        const idUsuario = "CORPME";
                        const idEstado = 5;

                        const query = `
                        EXEC notassimples.peticiones_historia_new
                            @idPeticion,
                            @idVersion,
                            @idUsuario,
                            @idEstado,
                            @comentario
                        `;

                        const request = new sql.Request();

                        request.input('idPeticion', sql.Int, idPeticion);
                        request.input('idVersion', sql.SmallInt, idVersion);
                        request.input('idUsuario', sql.VarChar(20), idUsuario);
                        request.input('idEstado', sql.TinyInt, idEstado);
                        request.input('comentario', sql.NVarChar(sql.MAX), comentario);

                        await request.query(query);

                        logger.info(`[processCorpmeFloti] PDF de nota simple guardado en la base de datos exitosamente para idCorpme: ${identificador}, idPeticion: ${idPeticion} e idVersion: ${idVersion}`);

                        // Llamada a modificarDBFConPython y manejo de posibles errores
                        try {
                            await modificarDBFConPython(idPeticion, idVersion);
                            logger.info(`[processCorpmeFloti] Generación de los archivos .dbf, .FPT y .mem ejecutada exitosamente para idPeticion: ${idPeticion} y idVersion: ${idVersion}`);
                        } catch (error) {
                            logger.error(`[processCorpmeFloti] Error al ejecutar modificarDBFConPython: ${error.message}`);
                            logger.info(`[processCorpmeFloti] Error al ejecutar modificarDBFConPython para idPeticion: ${idPeticion} y idVersion: ${idVersion}`);
                        }

                    } else {
                        logger.info(`[processCorpmeFloti] No se encontraron idPeticion o idVersion asociados con el identificador corpme`);
                    }

                    // Leer y enviar XML de confirmación
                    const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    res.set('Content-Type', 'text/xml');
                    res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processCorpmeFloti] Error al guardar el PDF en la base de datos: ${err}`);
                    if (!res.headersSent) res.status(500).send('Error al guardar el PDF en la base de datos');
                    return;
                }
            }
        } else if (codigoTipoRespuesta === '11') {
            // Si tipo-respuesta es 11, es la nota simple reenviada
            let ficheroPdfBase64;
            if (informacion && informacion.fichero && informacion.fichero.length > 0) {
                ficheroPdfBase64 = informacion.fichero[0]['_'];

                try {

                    const idPeticion = await getIdPeticionByIdCorpme(identificador);  // Función para obtener idPeticion
                    const idVersion = await getIdVersionByIdCorpme(identificador);    // Función para obtener idVersion
                    // Conexión a la base de datos
                    await sql.connect(config);
                    const query = `UPDATE peticiones SET pdf = @pdf, IdEstado = 5, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                    const request = new sql.Request();
                    const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');
                    request.input('pdf', sql.VarBinary(sql.MAX), pdfBuffer);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    request.input('idPeticion', sql.Int, idPeticion);
                    request.input('idVersion', sql.SmallInt, idVersion);
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    await request.query(query);

                    logger.info('[processCorpmeFloti] (Reenvio así­ncrono) PDF guardado en la base de datos exitosamente.');

                    if (idPeticion && idVersion) {
                        const comentario = 'Recepción de NS por GT';
                        const idUsuario = "CORPME";
                        const idEstado = 5;

                        const query = `
                        EXEC notassimples.peticiones_historia_new
                            @idPeticion,
                            @idVersion,
                            @idUsuario,
                            @idEstado,
                            @comentario
                        `;

                        const request = new sql.Request();

                        request.input('idPeticion', sql.Int, idPeticion);
                        request.input('idVersion', sql.SmallInt, idVersion);
                        request.input('idUsuario', sql.VarChar(20), idUsuario);
                        request.input('idEstado', sql.TinyInt, idEstado);
                        request.input('comentario', sql.NVarChar(sql.MAX), comentario);

                        await request.query(query);
                        logger.info(`PDF de nota simple reenviada de manera asícrono guardado en la base de datos exitosamente para idCorpme: ${identificador}, idPeticion: ${idPeticion} e idVersion: ${idVersion}`);

                    } else {
                        logger.info(`[processCorpmeFloti] No se encontraron idPeticion o idVersion asociados con el identificador corpme`);
                    }

                    // Leer y enviar XML de confirmación
                    const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    res.set('Content-Type', 'text/xml');
                    res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processCorpmeFloti] Error al guardar el PDF en la base de datos: ${err}`);
                    if (!res.headersSent) res.status(500).send('Error al guardar el PDF en la base de datos');
                    return;
                }
            }
        } else if (codigoTipoRespuesta === '0') {
            // Soklicitud reenviada a otro registro. Se mantiene la solicitue en espera IdEstado = 2
            try {
                // Obtener idPeticion y idVersion
                const idPeticion = await getIdPeticionByIdCorpme(identificador);
                const idVersion = await getIdVersionByIdCorpme(identificador);
                await sql.connect(config);
                // Guardar tipo-respuesta en la tabla peticiones
                const query = `UPDATE peticiones SET IdEstado = 2, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                const request = new sql.Request();
                request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                request.input('idCorpme', sql.VarChar(50), identificador);
                request.input('idPeticion', sql.Int, idPeticion);
                request.input('idVersion', sql.SmallInt, idVersion);
                await request.query(query);

                if (idPeticion && idVersion) {
                    // Llamar al procedimiento con el comentario basado en informacion.texto
                    let textoIntermedio;
                    textoIntermedio = 'Desconocido';

                    const textoTipoRespuesta = informacion && informacion.texto ? informacion.texto[0] : 'Sin información adicional';
                    const comentario = `Aviso de redirección: La petición ha sido redirigida a otro Registro. idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta}`;
                    const idUsuario = "CORPME";
                    const idEstado = 2;

                    const query = `
                        EXEC notassimples.peticiones_historia_new
                            @idPeticion,
                            @idVersion,
                            @idUsuario,
                            @idEstado,
                            @comentario
                        `;

                    const request = new sql.Request();

                    request.input('idPeticion', sql.Int, idPeticion);
                    request.input('idVersion', sql.SmallInt, idVersion);
                    request.input('idUsuario', sql.VarChar(20), idUsuario);
                    request.input('idEstado', sql.TinyInt, idEstado);
                    request.input('comentario', sql.NVarChar(sql.MAX), comentario);

                    await request.query(query);
                    logger.info(`[processCorpmeFloti] Aviso de redirección: La petición ha sido redirigida a otro Registro. idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta} | idCorpme: ${identificador} | idPeticion: ${idPeticion} | idVersion:${idPeticion}.`);
                } else {
                    logger.info(`[processCorpmeFloti] No se encontraron idPeticion o idVersion asociados con el identificador corpme`);
                }

                // Enviar confirmación sin el procesamiento del PDF
                const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                res.set('Content-Type', 'text/xml');
                res.send(confirmacionXml);

            } catch (err) {
                logger.error(`[processCorpmeFloti] Error al guardar el tipo-respuesta en la base de datos: ${err}`);
                if (!res.headersSent) res.status(500).send('Error al procesar la respuesta');
            }
        } else {
            // Notas denegadas 
            if (codigoTipoRespuesta === '12') {
                // Nota simple reenviada negativa
                try {
                    // Obtener idPeticion y idVersion
                    const idPeticion = await getIdPeticionByIdCorpme(identificador);
                    const idVersion = await getIdVersionByIdCorpme(identificador);
                    await sql.connect(config);
                    // Guardar tipo-respuesta en la tabla peticiones
                    const query = `UPDATE peticiones SET IdEstado = 7, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme AND idPeticion = @idPeticion AND idVersion = @idVersion`;
                    const request = new sql.Request();
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    request.input('idPeticion', sql.Int, idPeticion);
                    request.input('idVersion', sql.SmallInt, idVersion);
                    await request.query(query);

                    if (idPeticion && idVersion) {
                        // Llamar al procedimiento con el comentario basado en informacion.texto
                        let textoIntermedio;
                        textoIntermedio = 'Desconocido';

                        const textoTipoRespuesta = informacion && informacion.texto ? informacion.texto[0] : 'Sin información adicional';
                        const comentario = `Petición denegada por Registradores: idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta}`;
                        const idUsuario = "CORPME";
                        const idEstado = 7;

                        const query = `
                            EXEC notassimples.peticiones_historia_new
                                @idPeticion,
                                @idVersion,
                                @idUsuario,
                                @idEstado,
                                @comentario
                            `;

                        const request = new sql.Request();

                        request.input('idPeticion', sql.Int, idPeticion);
                        request.input('idVersion', sql.SmallInt, idVersion);
                        request.input('idUsuario', sql.VarChar(20), idUsuario);
                        request.input('idEstado', sql.TinyInt, idEstado);
                        request.input('comentario', sql.NVarChar(sql.MAX), comentario);

                        await request.query(query);
                        logger.info(`[processCorpmeFloti] Recibida respuesta negativa asíncrono para solicitud de nota simple: idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta} | idCorpme: ${identificador} | idPeticion: ${idPeticion} | idVersion:${idPeticion}.`);
                    } else {
                        logger.info(`[processCorpmeFloti] No se encontraron idPeticion o idVersion asociados con el identificador corpme`);
                    }

                    // Enviar confirmación sin el procesamiento del PDF
                    const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    res.set('Content-Type', 'text/xml');
                    res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processCorpmeFloti] Error al guardar el tipo-respuesta en la base de datos: ${err}`);
                    if (!res.headersSent) res.status(500).send('Error al procesar la respuesta');
                }
            } else {
                try {
                    await sql.connect(config);
                    // Guardar tipo-respuesta en la tabla peticiones
                    const query = `UPDATE peticiones SET IdEstado = 4, idRespuesta = @codigoTipoRespuesta WHERE idCorpme = @idCorpme`;
                    const request = new sql.Request();
                    request.input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta);
                    request.input('idCorpme', sql.VarChar(50), identificador);
                    await request.query(query);

                    // Obtener idPeticion y idVersion
                    const idPeticion = await getIdPeticionByIdCorpme(identificador);
                    const idVersion = await getIdVersionByIdCorpme(identificador);

                    if (idPeticion && idVersion) {
                        // Llamar al procedimiento con el comentario basado en informacion.texto
                        let textoIntermedio;
                        switch (codigoTipoRespuesta) {
                            case '20':
                                textoIntermedio = 'Denegación';
                                break;
                            case '21':
                                textoIntermedio = 'Denegación por inconsistencia de datos';
                                break;
                            case '22':
                                textoIntermedio = 'Denegación por falta de datos';
                                break;
                            case '23':
                                textoIntermedio = 'Denegación por demasiados titulares coincidentes';
                                break;
                            case '24':
                                textoIntermedio = 'Denegación por finca inexistente';
                                break;
                            default:
                                textoIntermedio = 'Denegación';
                                break;
                        }
                        const textoTipoRespuesta = informacion && informacion.texto ? informacion.texto[0] : 'Sin información adicional';
                        const comentario = `Petición denegada por Registradores: idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta}`;
                        //const idUsuario = await getIdUsuarioByIdPeticionAndIdVersion(idPeticion, idVersion);
                        const idUsuario = "CORPME";
                        const idEstado = 4;

                        const query = `
                            EXEC notassimples.peticiones_historia_new
                                @idPeticion,
                                @idVersion,
                                @idUsuario,
                                @idEstado,
                                @comentario
                            `;

                        const request = new sql.Request();

                        request.input('idPeticion', sql.Int, idPeticion);
                        request.input('idVersion', sql.SmallInt, idVersion);
                        request.input('idUsuario', sql.VarChar(20), idUsuario);
                        request.input('idEstado', sql.TinyInt, idEstado);
                        request.input('comentario', sql.NVarChar(sql.MAX), comentario);

                        await request.query(query);
                        logger.info(`[processCorpmeFloti] Petición denegada por Registradores: idRespuesta: ${codigoTipoRespuesta} | ${textoIntermedio} | ${textoTipoRespuesta} | idCorpme: ${identificador} | idPeticion: ${idPeticion} | idVersion:${idVersion}.`);
                    } else {
                        logger.info(`[processCorpmeFloti]No se encontraron idPeticion ${idPeticion} o idVersion ${idPeticion} asociados con el identificador corpme: ${identificador}`);
                    }

                    // Enviar confirmación sin el procesamiento del PDF
                    const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
                    res.set('Content-Type', 'text/xml');
                    res.send(confirmacionXml);

                } catch (err) {
                    logger.error(`[processCorpmeFloti] Error al guardar el tipo-respuesta en la base de datos: ${err}`);
                    if (!res.headersSent) res.status(500).send('Error al procesar la respuesta');
                }
            }
        }
    } else {
        res.status(400).send('Formato de XML inválido o datos faltantes');
        logger.info(`[processCorpmeFloti] Formato de XML inválido o datos faltantes`);
    }
}

// Función para procesar el XML de tipo 'corpme-floti-facturacion' segÃºn recibe los datos
// async function processCorpmeFlotiFacturacion(xmlData, res) {
//     const facturacion = xmlData['corpme-floti-facturacion'];
//     const facturacionData = facturacion.facturacion ? facturacion.facturacion[0] : null;

//     // Se convierte el objeto JavaScript de vuelta a formato XML
//     const xmlString = builder.buildObject(xmlData);

//     // Generar el nombre del archivo en formato YYYY_MM_DD_Facturacion.xml
//     const now = new Date();
//     const year = now.getFullYear();
//     const month = String(now.getMonth() + 1).padStart(2, '0'); // Mes en formato 2 dÃ­gitos
//     const day = String(now.getDate()).padStart(2, '0'); // DÃ­a en formato 2 dÃ­gitos
//     const seconds = String(now.getSeconds()).padStart(2, '0');
//     const fileName = `GTREGAPP_${year}_${month}_${day}_${seconds}.xml`;

//     fs.writeFile(`./xml_facturas_recibidas/${fileName}`, xmlString, (err) => {
//         if (err) {
//             logger.error('Error al guardar el archivo XML:', err);
//             if (!res.headersSent) res.status(500).send('Error al guardar el archivo XML');
//             return;
//         }
//         logger.info(`Archivo XML de facturación guardado`);
//         logger.info(`Archivo XML de facturación guardado`);
//     });

//     if (facturacionData) {

//         // Leer y enviar XML de confirmación. Lo pogo aquÃ­ para evita rposibles problemas con el Timeout se Regitradores 
//         const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok_fact.xml'), 'utf8');
//         res.set('Content-Type', 'text/xml');
//         res.send(confirmacionXml);

//         // Extraer datos principales de facturación
//         const idFactura = facturacion.$['id'];
//         const idUsuario = facturacionData.$['id'];
//         const importeBase = facturacionData.$['importe-base'];
//         const importeImpuesto = facturacionData.$['importe-impuesto'];
//         const periodoInicio = facturacionData.$['periodo-inicio'];
//         const periodoFin = facturacionData.$['periodo-fin'];

//         let pool;

//         try {


//             // Conexión a la base de datos
//             pool = await sql.connect(config);

//             // Insertar datos en la tabla facturación_factura
//             const facturaQuery = `INSERT INTO facturacion_factura ("factura_idFactura", "factura_idUsuario", "factura_importe-base", "factura_importe-impuesto", "factura_periodo-inicio", "factura_periodo-fin")
//                                 OUTPUT INSERTED.factura_idTabla 
//                                 VALUES (@id_factura, @id_usuario, @importe_base, @importe_impuesto, @periodo_inicio, @periodo_fin);`;
//             const requestFactura = pool.request();
//             requestFactura.input('id_factura', sql.VarChar(50), idFactura);
//             requestFactura.input('id_usuario', sql.VarChar(50), idUsuario);
//             requestFactura.input('importe_base', sql.Money, parseFloat(importeBase));
//             requestFactura.input('importe_impuesto', sql.Money, parseFloat(importeImpuesto));
//             requestFactura.input('periodo_inicio', sql.SmallDateTime, new Date(periodoInicio));
//             requestFactura.input('periodo_fin', sql.SmallDateTime, new Date(periodoFin));

//             const result = await requestFactura.query(facturaQuery);
//             const IdTabla = result.recordset[0].factura_idTabla;

//             for (let factura of facturacionData.factura) {

//                 // Extraer información del nodo 'factura'
//                 const ejercicio = factura.$['ejercicio'];
//                 const fechaFactura = factura.$['fecha'];
//                 const numeroFactura = factura.$['numero'];
//                 const regimenCajaB = factura.$['regimen-caja'];
//                 let regimenCaja = 0;
//                 if (regimenCajaB=='true'){
//                     regimenCaja = 1;
//                 }
//                 const serie = factura.$['serie'];

//                 // Extraer datos del nodo 'emisor'
//                 const emisor = factura.emisor ? factura.emisor[0].$ : {};
//                 let emisorNif = emisor['nif'];
//                 // Completar con ceros a la izquierda
//                 if (emisorNif) {
//                     emisorNif = emisorNif.padStart(9, '0');
//                 }
//                 let emisorCp = emisor['cp'];
//                 // Completar con ceros a la izquierda
//                 if (emisorCp) {
//                     emisorCp = emisorCp.padStart(5, '0');
//                 }
//                 const emisorDomicilio = emisor['domicilio'];
//                 const emisorMunicipio = emisor['municipio'];
//                 const emisorNombre = emisor['nombre'];
//                 const emisorProvincia = emisor['provincia'];

//                 // Extraer datos del nodo 'importe'
//                 const importe = factura.importe ? factura.importe[0].$ : {};
//                 const peticionBase = importe['base'];
//                 const peticionImpuesto = importe['impuesto'];
//                 const peticionIrpf = importe['irpf'];

//                 // Verificar si hay un valor Ãºnico en la tabla registros_emisor
//                 let codigoRegistro = 0;
//                 let descripcionEmplazamiento = 'No hay datos o hay mas de un registro';

//                 if (emisorNif) {
//                     const codigoRegistroQuery = `
//                         SELECT CodigoRegistro 
//                         FROM registros_emisor 
//                         WHERE NIFEmisor = @emisor_nif 
//                         GROUP BY CodigoRegistro 
//                         HAVING COUNT(*) = 1;`;
//                     const requestCodigo = pool.request();
//                     requestCodigo.input('emisor_nif', sql.VarChar(20), emisorNif);

//                     const resultCodigo = await requestCodigo.query(codigoRegistroQuery);
//                     if (resultCodigo.recordset.length === 1) {
//                         codigoRegistro = resultCodigo.recordset[0].CodigoRegistro;

//                         // Obtener la descripción del emplazamiento
//                         const descripcionQuery = `
//                             SELECT Descripcion 
//                             FROM registros_emplazamiento 
//                             WHERE CodigoRegistro = @codigo_registro;`;
//                         const requestDescripcion = pool.request();
//                         requestDescripcion.input('codigo_registro', sql.Int, codigoRegistro);

//                         const resultDescripcion = await requestDescripcion.query(descripcionQuery);
//                         if (resultDescripcion.recordset.length === 1) {
//                             const Descrip = resultDescripcion.recordset[0].Descripcion;
//                             descripcionEmplazamiento = `Registro de la Propiedad de ${Descrip}`;
//                         } else {
//                             logger.info(`No se encontró una descripción Ãºnica para CodigoRegistro: ${codigoRegistro}`);
//                         }
//                     } else {
//                         logger.info(`No se encontró un Ãºnico registro para el NIF: ${emisorNif}`);
//                     }

//                     // Insertar datos en la tabla facturacion_emisor
//                     const emisorQuery = `
//                     INSERT INTO facturacion_emisor (factura_idTabla, emisor_codigoRegistro, emisor_nombreRegistro, emisor_nif, emisor_nombre, emisor_domicilio, emisor_municipio, emisor_provincia, emisor_cp, emisor_base, emisor_impuesto, emisor_irpf, "emisor_fecha-factura", emisor_ejercicio, emisor_serie, emisor_numero, "emisor_regimen-caja") 
//                     VALUES (@factura_idTabla, @codigo_registro, @descripcion_emplazamiento, @nif, @nombre, @domicilio, @municipio, @provincia, @cp, @emisor_base, @emisor_impuesto, @emisor_irpf, @fecha_factura, @ejercicio, @serie, @numero, @regimen_caja);`;
//                     const requestEmisor  = pool.request();
//                     requestEmisor.input('factura_idTabla', sql.Int, IdTabla); // facturaId debe ser el ID autoincremental de la factura
//                     requestEmisor.input('codigo_registro', sql.Int, codigoRegistro);
//                     requestEmisor.input('descripcion_emplazamiento', sql.VarChar(250), descripcionEmplazamiento);
//                     requestEmisor.input('nif', sql.VarChar(20), emisorNif);
//                     requestEmisor.input('nombre', sql.VarChar(250), emisorNombre);
//                     requestEmisor.input('domicilio', sql.VarChar(250), emisorDomicilio);
//                     requestEmisor.input('municipio', sql.VarChar(250), emisorMunicipio);
//                     requestEmisor.input('provincia', sql.VarChar(50), emisorProvincia);
//                     requestEmisor.input('cp', sql.VarChar(5), emisorCp);
//                     requestEmisor.input('emisor_base', sql.Money, parseFloat(peticionBase));
//                     requestEmisor.input('emisor_impuesto', sql.Money, parseFloat(peticionImpuesto));
//                     requestEmisor.input('emisor_irpf', sql.Money, parseFloat(peticionIrpf));
//                     requestEmisor.input('fecha_factura', sql.SmallDateTime, fechaFactura);
//                     requestEmisor.input('ejercicio', sql.Int, ejercicio);
//                     requestEmisor.input('serie', sql.VarChar(10), serie);
//                     requestEmisor.input('numero', sql.VarChar(5), numeroFactura);
//                     requestEmisor.input('regimen_caja', sql.Int, regimenCaja);

//                     await requestEmisor.query(emisorQuery);
//                     //logger.info(`Registro agregado a facturacion_emisor: factura_idTabla=${IdTabla}, codigoRegistro=${codigoRegistro}`);          

//                 }

//                 // Asegurarse de que 'peticion' sea un array.
//                 const peticiones = Array.isArray(factura.peticion) ? factura.peticion : [factura.peticion];

//                 // Iterar sobre todas las peticiones en cada factura
//                 for (let peticion of peticiones) {
//                     if (peticion) {
//                         // Extraer datos de la petición
//                         // const grupo = peticion.$['grupo'];
//                         const idPeticion = peticion.$['id'];
//                         // const usuario = peticion.$['usuario'];
//                         const fecha = peticion.$['fecha'];
//                         const fechaRespuesta = peticion.$['fecha-respuesta'];
//                         // const tipo = peticion.$['tipo'];
//                         const importeBasePeticion = peticion.$['importe-base'];
//                         const porcentajeImpuesto = peticion.$['porcentaje-impuesto'];
//                         const referencia = peticion.$['referencia'];

//                         // Insertar datos en la tabla facturación_peticion
//                         const peticionQuery = `INSERT INTO facturacion_peticion (factura_idTabla, emisor_codigoRegistro, emisor_nif, peticion_idCorpme, "peticion_fecha-peticion", "peticion_fecha-respuesta","peticion_importe-base","peticion_porcentaje-impuesto", peticion_referencia) 
//                         VALUES (@factura_idTabla, @emisor_codigoRegistro, @emisor_nif, @id_peticion, @fecha, @fecha_respuesta, @importe_base, @porcentaje_impuesto, @referencia);`;
//                         const requestPeticion  = pool.request();
//                         requestPeticion.input('factura_idTabla', sql.Int,  IdTabla);
//                         requestPeticion.input('emisor_codigoRegistro', sql.Int, codigoRegistro);
//                         requestPeticion.input('emisor_nif', sql.VarChar(20), emisorNif);
//                         requestPeticion.input('id_peticion', sql.VarChar(50), idPeticion);
//                         requestPeticion.input('fecha', sql.SmallDateTime, new Date(fecha));
//                         requestPeticion.input('fecha_respuesta', sql.SmallDateTime, new Date(fechaRespuesta));
//                         requestPeticion.input('importe_base', sql.Money, parseFloat(importeBasePeticion));
//                         requestPeticion.input('porcentaje_impuesto', sql.Decimal(5, 2), parseFloat(porcentajeImpuesto));
//                         requestPeticion.input('referencia', sql.VarChar(50), referencia);

//                         await requestPeticion.query(peticionQuery);
//                         //logger.info(`Información de facturación almacenada factura_id: ${IdTabla}`);
//                     }
//                 }
//             }

//             // Leer y enviar XML de confirmación LO ADELANTO PARA QUE NO HAYA PROBLEMAS CON EL TIMEOUT
//             //const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok_fact.xml'), 'utf8');
//             //res.set('Content-Type', 'text/xml');
//             //res.send(confirmacionXml);
//             logger.info(`Información de facturación almacenada factura_id: ${IdTabla}`);
//         } catch (err) {
//             logger.error('Error al guardar en la base de datos:', err);
//             logger.info(`Error al guardar los datos de facturación en la base de datos`);
//             if (!res.headersSent) res.status(500).send('Error al guardar los datos de facturación en la base de datos');
//             return;
//         } finally {
//             if (pool) {
//                 await pool.close(); 
//             }
//         }
//     } else {
//         res.status(400).send('Formato de XML inválido o datos faltantes');
//     }
// }

// Función para procesar el XML de tipo 'corpme-floti-facturacion' desde el archivo grabado
async function processCorpmeFlotiFacturacion(xmlData, res) {
    // Convertir el objeto JS original a string XML
    const xmlString = builder.buildObject(xmlData);

    // Generar nombre de archivo
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const fileName = `GTREGAPP_${year}_${month}_${day}_${seconds}.xml`;
    const filePath = `./xml_facturas_recibidas/${fileName}`;

    try {
        await fsp.writeFile(filePath, xmlString, 'utf8');
        logEscritura(logger, 'XML Facturación', './xml_facturas_recibidas/', fileName);
    } catch (err) {
        logger.error('Error al guardar el archivo XML:', err);
        if (!res.headersSent) res.status(500).send('Error al guardar el archivo XML');
        return;
    }

    // Leer y parsear el XML guardado
    let parsedXml;
    try {
        const xmlContent = await fsp.readFile(filePath, 'utf8');
        parsedXml = await xml2js.parseStringPromise(xmlContent);
    } catch (err) {
        logger.error(`[processCorpmeFlotiFacturacion] Error al leer o parsear el archivo XML: ${err}`);
        if (!res.headersSent) res.status(500).send('Error al procesar el archivo XML guardado');
        return;
    }

    const facturacion = parsedXml['corpme-floti-facturacion'];
    const facturacionData = facturacion?.facturacion?.[0] ?? null;

    if (!facturacionData) {
        res.status(400).send('Formato de XML inválido o datos faltantes');
        return;
    }

    // Enviar confirmación inmediatamente para evitar timeout
    const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok_fact.xml'), 'utf8');
    res.set('Content-Type', 'text/xml');
    res.send(confirmacionXml);

    const idFactura = facturacion.$['id'];
    const idUsuario = facturacionData.$['id'];
    const importeBase = facturacionData.$['importe-base'];
    const importeImpuesto = facturacionData.$['importe-impuesto'];
    const periodoInicio = facturacionData.$['periodo-inicio'];
    const periodoFin = facturacionData.$['periodo-fin'];

    let pool;

    try {
        pool = new sql.ConnectionPool(config);
        await pool.connect();

        const facturaQuery = `INSERT INTO facturacion_factura ("factura_idFactura", "factura_idUsuario", "factura_importe-base", "factura_importe-impuesto", "factura_periodo-inicio", "factura_periodo-fin")
                            OUTPUT INSERTED.factura_idTabla 
                            VALUES (@id_factura, @id_usuario, @importe_base, @importe_impuesto, @periodo_inicio, @periodo_fin);`;
        const requestFactura = pool.request();
        requestFactura.input('id_factura', sql.VarChar(50), idFactura);
        requestFactura.input('id_usuario', sql.VarChar(50), idUsuario);
        requestFactura.input('importe_base', sql.Money, parseFloat(importeBase));
        requestFactura.input('importe_impuesto', sql.Money, parseFloat(importeImpuesto));
        requestFactura.input('periodo_inicio', sql.SmallDateTime, new Date(periodoInicio));
        requestFactura.input('periodo_fin', sql.SmallDateTime, new Date(periodoFin));

        const result = await requestFactura.query(facturaQuery);
        const IdTabla = result.recordset[0].factura_idTabla;

        let cont_peticiones = 0
        let suma_euros_peticiones = 0

        for (let factura of facturacionData.factura) {
            const ejercicio = factura.$['ejercicio'];
            const fechaFactura = factura.$['fecha'];
            const numeroFactura = factura.$['numero'];
            const regimenCajaB = factura.$['regimen-caja'];
            const serie = factura.$['serie'];
            const regimenCaja = regimenCajaB === 'true' ? 1 : 0;

            const emisor = factura.emisor?.[0]?.$ ?? {};
            let emisorNif = emisor['nif']?.padStart(9, '0');
            let emisorCp = emisor['cp']?.padStart(5, '0');
            const emisorDomicilio = emisor['domicilio'];
            const emisorMunicipio = emisor['municipio'];
            const emisorNombre = emisor['nombre'];
            const emisorProvincia = emisor['provincia'];

            const importe = factura.importe?.[0]?.$ ?? {};
            const peticionBase = importe['base'];
            const peticionImpuesto = importe['impuesto'];
            const peticionIrpf = importe['irpf'];

            let codigoRegistro = 0;
            let descripcionEmplazamiento = 'No hay datos o hay más de un registro';

            if (emisorNif) {
                const codigoRegistroQuery = `
                    SELECT CodigoRegistro,Descripcion
                    FROM [TASADORES].[notassimples].registros_emplazamiento 
                    WHERE CodigoRegistro = (SELECT TOP 1 CodigoRegistro 
                        FROM [TASADORES].[notassimples].registros_emisor 
                        WHERE NIFEmisor = @emisor_nif )`;
                ;

                const requestDescripcion = pool.request();
                requestDescripcion.input('emisor_nif', sql.VarChar(20), emisorNif);
                const resultDescripcion = await requestDescripcion.query(codigoRegistroQuery);

                if (resultDescripcion.recordset.length === 1) {
                    descripcionEmplazamiento = `Registro de la Propiedad de ${resultDescripcion.recordset[0].Descripcion}`;
                    codigoRegistro = resultDescripcion.recordset[0].CodigoRegistro
                } else {
                    logger.info(`[processCorpmeFlotiFacturacion] No se encontró un único registro para el NIF: ${emisorNif}`);
                }

                const emisorQuery = `INSERT INTO facturacion_emisor (factura_idTabla, emisor_codigoRegistro, emisor_nombreRegistro, emisor_nif, emisor_nombre, emisor_domicilio, emisor_municipio, emisor_provincia, emisor_cp, emisor_base, emisor_impuesto, emisor_irpf, "emisor_fecha-factura", emisor_ejercicio, emisor_serie, emisor_numero, "emisor_regimen-caja") 
                VALUES (@factura_idTabla, @codigo_registro, @descripcion_emplazamiento, @nif, @nombre, @domicilio, @municipio, @provincia, @cp, @emisor_base, @emisor_impuesto, @emisor_irpf, @fecha_factura, @ejercicio, @serie, @numero, @regimen_caja);`;
                const requestEmisor = pool.request();
                requestEmisor.input('factura_idTabla', sql.Int, IdTabla);
                requestEmisor.input('codigo_registro', sql.Int, codigoRegistro);
                requestEmisor.input('descripcion_emplazamiento', sql.VarChar(250), descripcionEmplazamiento);
                requestEmisor.input('nif', sql.VarChar(20), emisorNif);
                requestEmisor.input('nombre', sql.VarChar(250), emisorNombre);
                requestEmisor.input('domicilio', sql.VarChar(250), emisorDomicilio);
                requestEmisor.input('municipio', sql.VarChar(250), emisorMunicipio);
                requestEmisor.input('provincia', sql.VarChar(50), emisorProvincia);
                requestEmisor.input('cp', sql.VarChar(5), emisorCp);
                requestEmisor.input('emisor_base', sql.Money, parseFloat(peticionBase));
                requestEmisor.input('emisor_impuesto', sql.Money, parseFloat(peticionImpuesto));
                requestEmisor.input('emisor_irpf', sql.Money, parseFloat(peticionIrpf));
                requestEmisor.input('fecha_factura', sql.SmallDateTime, fechaFactura);
                requestEmisor.input('ejercicio', sql.Int, ejercicio);
                requestEmisor.input('serie', sql.VarChar(10), serie);
                requestEmisor.input('numero', sql.VarChar(5), numeroFactura);
                requestEmisor.input('regimen_caja', sql.Int, regimenCaja);

                await requestEmisor.query(emisorQuery);

            }

            const peticiones = Array.isArray(factura.peticion) ? factura.peticion : [factura.peticion];

            for (let peticion of peticiones) {
                if (!peticion) continue;

                try {
                    const idPeticion = peticion.$['id'];
                    const fecha = peticion.$['fecha'];
                    const fechaRespuesta = peticion.$['fecha-respuesta'];
                    const importeBasePeticion = peticion.$['importe-base'];
                    const porcentajeImpuesto = peticion.$['porcentaje-impuesto'];
                    const referencia = peticion.$['referencia'];

                    // PREVENCIÓN DE ERRORES: Validar los datos antes de inyectarlos
                    const fechaParsed = fecha ? new Date(fecha) : null;
                    const fechaRespuestaParsed = fechaRespuesta ? new Date(fechaRespuesta) : null;
                    const importeParsed = importeBasePeticion ? parseFloat(importeBasePeticion) : 0;
                    const porcentajeParsed = porcentajeImpuesto ? parseFloat(porcentajeImpuesto) : 0;

                    const peticionQuery = `INSERT INTO facturacion_peticion (factura_idTabla, emisor_codigoRegistro, emisor_nif, peticion_idCorpme, "peticion_fecha-peticion", "peticion_fecha-respuesta","peticion_importe-base","peticion_porcentaje-impuesto", peticion_referencia) 
                    VALUES (@factura_idTabla, @emisor_codigoRegistro, @emisor_nif, @id_peticion, @fecha, @fecha_respuesta, @importe_base, @porcentaje_impuesto, @referencia);`;
                    
                    const requestPeticion = pool.request();
                    requestPeticion.input('factura_idTabla', sql.Int, IdTabla);
                    requestPeticion.input('emisor_codigoRegistro', sql.Int, codigoRegistro);
                    requestPeticion.input('emisor_nif', sql.VarChar(20), emisorNif);
                    requestPeticion.input('id_peticion', sql.VarChar(50), idPeticion);
                    requestPeticion.input('fecha', sql.SmallDateTime, fechaParsed);
                    requestPeticion.input('fecha_respuesta', sql.SmallDateTime, fechaRespuestaParsed);
                    requestPeticion.input('importe_base', sql.Money, importeParsed);
                    requestPeticion.input('porcentaje_impuesto', sql.Decimal(5, 2), porcentajeParsed);
                    requestPeticion.input('referencia', sql.VarChar(50), referencia);

                    await requestPeticion.query(peticionQuery);

                } catch (petErr) {
                    logger.error(`[processCorpmeFlotiFacturacion] Error al insertar la petición ID ${peticion.$ ? peticion.$['id'] : 'Desconocido'}: ${petErr.message}`);
                    console.error(petErr); 
                }
            }


            suma_euros_peticiones = suma_euros_peticiones + peticionBase
            ++cont_peticiones
        }

        logger.info(`[processCorpmeFlotiFacturacion] Información de facturación almacenada factura_id: ${IdTabla}`);
    } catch (err) {
        logger.error(`[processCorpmeFlotiFacturacion] Error crítico en la base de datos: ${err.message}`);
        console.error(err); 
        if (!res.headersSent) res.status(500).send('Error al guardar los datos de facturación en la base de datos');
    } finally {

        if (pool) {
            try {
                await pool.close();
                logger.info('Conexión de facturación cerrada correctamente');
            } catch (closeErr) {
                logger.error('Error al cerrar la conexón:', closeErr);
            }
        }

    }
}
///////    EN DOCKER NO HACE FALTA HTTPS, tenemos un PROXY REVERSO DELANTE QUE SE ENCARGA
///////    // Opciones de HTTPS incluyendo el archivo .pfx y la contraseña
///////    const credentials = {
///////        pfx: fs.readFileSync(process.env.SSL_PFX_PATH),
///////        passphrase: process.env.SSL_PFX_PASSWORD
///////    };
///////    
///////    const httpsServer = https.createServer(credentials, app);
///////    httpsServer.setTimeout(0);
///////    
///////    httpsServer.listen(port, () => {
///////        logger.info(`Servidor escuchando en https://localhost:${port}`);
///////        logger.info(`Servidor iniciado en puerto ${port}`);
///////    });
///////    




// Middleware Gestor de Errores Global (Captura 413 y otros)
app.use((err, req, res, next) => {
    logger.error({
        msg: 'Error global atrapado',
        status: err.status || 500,
        errMessage: err.message,
        ruta: req.originalUrl,
        ip: req.ip
    });

    if (err.type === 'entity.too.large') {
        return res.status(413).send({ error: 'La respuesta excedió el tamaÃ±o permitido.' });
    }

    res.status(err.status || 500).send({ error: 'Hubo un problema procesando la petición.' });
});

// Verificar carpetas de escritura al iniciar el servidor
try {
    verificarCarpetasEscritura(logger);
} catch (err) {
    logger.error('Error en verificación de carpetas:', err.message);
    process.exit(1);
}

// Crear servidor HTTP en lugar de HTTPS
const httpServer = http.createServer(app);
httpServer.setTimeout(0);
httpServer.listen(port, () => {
    logger.info(`Servidor escuchando en http://localhost:${port}`);
    logger.info(`Servidor iniciado en puerto ${port}`);
});




function runFetchPendingRequests() {
    // logger.info("=== Ejecutando ciclo de fetchPendingRequests (setInterval) ===");
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
                if (data.resultadosReenvio.length > 0) {
                    sendXMLReenvio(data.resultadosReenvio);
                }
            } else {
                logger.info("No hay solicitudes sin tramitar.");
            }
        })
        .catch(err => {
            logger.error('Error en el ciclo de fetchPendingRequests:', err);
        });
}

// Configurar la función para ejecutarse cada 10 minutos (600000 milisegundos)
setInterval(runFetchPendingRequests, 20000);       