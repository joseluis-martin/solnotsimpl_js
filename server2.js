/**************************************************
 * server.js (Reescritura usando pool global)
 **************************************************/
require('dotenv').config();  // Carga variables de entorno
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const xml2js = require('xml2js');
const builder = new xml2js.Builder();
const axios = require('axios');
const xmlparser = require('express-xml-bodyparser');
const pdf = require('pdf-parse');
const moment = require('moment');
const { exec } = require('child_process');

// IMPORTANTE: Usamos nuestro db.js
const { sql, pool, connectDB } = require('./db');  // <-- cambio

const app = express();
const upload = multer({ dest: 'uploads/' });

// Variables de entorno
const url = process.env.XML_URL;
const port = process.env.PORT;
const logFilePath = './logs/actions.log';

const CREDENCIALES = {
    ENTIDAD: process.env.ENTIDAD,
    GRUPO: process.env.GRUPO,
    USUARIO: process.env.USUARIO,
    EMAIL: process.env.EMAIL
};

// Axios para llamadas HTTP/HTTPS
const instance = axios.create({
    httpsAgent: new https.Agent({  
        rejectUnauthorized: false 
    }),
    retry: 0, 
    timeout: 10000 
});

// Middleware
app.use(express.json());
app.use(xmlparser());
app.use(express.static('public')); // archivos estáticos

// ---------------------------------------------------
// 1) Autenticación básica para /admin, /status, /logs
// ---------------------------------------------------
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
        return next();
    }
    return res.status(401).send('Credenciales incorrectas.');
}
app.use(['/admin', '/status', '/logs', '/stop', '/restart'], basicAuth);

// -------------------------------------------
// 2) Función para loguear acciones en archivo
// -------------------------------------------
function logAction(action) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${action}\n`;
    fs.appendFileSync(logFilePath, logMessage);
}

// ------------------------------
// 3) Rutas principales de Express
// ------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '/public/admin.html'));
});

app.get('/status', (req, res) => {
    const serverStatus = {
        status: "running",
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version
    };
    res.json(serverStatus);
});

app.get('/logs', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const linesPerPage = parseInt(req.query.limit) || 100;
    const requestedDate = req.query.date ? moment(req.query.date, 'YYYY-MM-DD') : moment();

    if (!requestedDate.isValid()) {
        return res.status(400).send('Formato de fecha inválido (YYYY-MM-DD).');
    }

    try {
        const logContent = fs.readFileSync(logFilePath, 'utf8');
        const logLines = logContent.split('\n').filter(Boolean);
        const logsForDate = logLines.filter(line => {
            const timestamp = line.match(/\[(.*?)\]/);
            if (timestamp) {
                const logDate = moment(timestamp[1], 'YYYY-MM-DDTHH:mm:ss');
                return logDate.isSame(requestedDate, 'day');
            }
            return false;
        });

        const totalLines = logsForDate.length;
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
        const logsToShow = logsForDate.slice(startLine, endLine).join('\n');

        res.json({
            page: page,
            totalPages: totalPages,
            logs: logsToShow,
            date: requestedDate.format('YYYY-MM-DD')
        });
    } catch (error) {
        console.error(`Error al leer logs: ${error.message}`);
        res.status(500).send('Error al leer el archivo de logs');
    }
});

app.get('/stats', async (req, res) => {
    try {
        // Eliminamos sql.connect(config) y usamos pool:
        const query = `
            SELECT idEstado, COUNT(*) AS count
            FROM peticiones
            WHERE idEstado IN (2, 4, 5, 8)
            GROUP BY idEstado
        `;
        const result = await pool.request().query(query); // <-- cambio
        const stats = {
            enEspera: 0,
            respondidas: 0,
            denegadas: 0,
            anuladas: 0,
        };
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
        console.error('Error al obtener estadísticas:', error);
        res.status(500).send('Error al obtener estadísticas');
    }
});

// ---------------------------------------------
// 4) Función para extraer CSV y Huella de un PDF
// ---------------------------------------------
async function extractCodesFromPdf(pdfBuffer) {
    try {
        const data = await pdf(pdfBuffer);
        const pdfText = data.text;
        const csvRegex = /C\.?S\.?V\.?\s*:\s*([A-Za-z0-9]+)/i;
        const huellaRegex = /Huella\s*:\s*([a-f0-9\-]+)/i;
        const csvMatch = pdfText.match(csvRegex);
        const huellaMatch = pdfText.match(huellaRegex);
        const csvCode = csvMatch ? csvMatch[1] : null;
        const huellaCode = huellaMatch ? huellaMatch[1] : null;
        return {
            csvCode: csvCode || 'No encontrado',
            huellaCode: huellaCode || 'No encontrado'
        };
    } catch (error) {
        console.error('Error al parsear el PDF:', error);
        throw error;
    }
}

// -------------------------------------------
// 5) Funciones helper para obtener datos BBDD
// -------------------------------------------
async function getIdPeticionByIdCorpme(idCorpme) {
    const result = await pool.request()
        .input('idCorpme', sql.VarChar, idCorpme)
        .query('SELECT idPeticion FROM peticiones WHERE idCorpme = @idCorpme');
    return result.recordset.length > 0 ? result.recordset[0].idPeticion : null;
}

async function getIdVersionByIdCorpme(idCorpme) {
    const result = await pool.request()
        .input('idCorpme', sql.VarChar, idCorpme)
        .query('SELECT idVersion FROM peticiones WHERE idCorpme = @idCorpme');
    return result.recordset.length > 0 ? result.recordset[0].idVersion : null;
}

// (Si lo usas)
async function getIdUsuarioByIdPeticionAndIdVersion(idPeticion, idVersion) {
    const result = await pool.request()
        .input('idPeticion', sql.Int, idPeticion)
        .input('idVersion', sql.SmallInt, idVersion)
        .query(`SELECT idUsuario FROM peticiones 
                WHERE idPeticion=@idPeticion AND idVersion=@idVersion`);
    return result.recordset.length > 0 ? result.recordset[0].idUsuario : null;
}

// -----------------------------------------------------------------------
// 6) Función para modificar DBF mediante script Python y actualizar tablas
// -----------------------------------------------------------------------
async function modificarDBFConPython(idPeticion, idVersion) {
    try {
        // 1) get_For_DBF
        const queryDBF = `SELECT * FROM notassimples.get_For_DBF(@idPeticion, @idVersion)`;
        const dbfDataResult = await pool.request()
            .input('idPeticion', sql.Int, idPeticion)
            .input('idVersion', sql.SmallInt, idVersion)
            .query(queryDBF);
        const dbfData = dbfDataResult.recordset[0];

        if (!dbfData) {
            console.error('No se encontraron datos para el archivo DBF.');
            return;
        }

        const { IM_ANO_CLA, IM_NUM_TAS, IM_SUP_TAS, IMAGEN, NombreArchivo } = dbfData;

        // 2) idDocumento
        const queryidDocumento = `SELECT notassimples.peticiones_get_idDocumento(@idPeticion, @idVersion) AS idDocumento`;
        const queryidDocumentoResult = await pool.request()
            .input('idPeticion', sql.Int, idPeticion)
            .input('idVersion', sql.SmallInt, idVersion)
            .query(queryidDocumento);
        const idDocumento = queryidDocumentoResult.recordset[0].idDocumento;
        const NombreArchivoDoc = `${idDocumento}.dbf`;

        // 3) Ejecutar script Python
        exec(
          `python modificar_dbf.py ${IM_ANO_CLA} ${IM_NUM_TAS} ${IM_SUP_TAS} ${IMAGEN} ${NombreArchivoDoc}`, 
          (error, stdout, stderr) => {
            if (error) {
                console.error(`Error al ejecutar el script de Python: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`stderr de Python: ${stderr}`);
                return;
            }
            console.log(`Salida del script Python: ${stdout}`);
          }
        );

        // 4) Llamar a notassimples.peticiones_peticion_dbf_insert
        try {
            await pool.request()
                .input('idDocumento', sql.Int, idDocumento)
                .input('NombreArchivo', sql.VarChar(255), NombreArchivo)
                .query(`EXEC notassimples.peticiones_peticion_dbf_insert 
                        @idDocumento, @NombreArchivo`);
            console.log(`Registro insertado en peticiones_peticion_dbf_insert para idDocumento: ${idDocumento}, NombreArchivo: ${NombreArchivo}`);
            logAction(`Ejecutado peticiones_peticion_dbf_insert para idDocumento: ${idDocumento}, NombreArchivo: ${NombreArchivo}`);
        } catch (error) {
            console.error(`Error en peticiones_peticion_dbf_insert: ${error.message}`);
            logAction(`Error en peticiones_peticion_dbf_insert: ${error.message}`);
        }

        // 5) Llamar a notassimples.peticiones_historia_new
        try {
            const comentario = `Generación del archivo DBF: ${NombreArchivo}`;
            await pool.request()
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .input('idUsuario', sql.VarChar(20), 'SRVREG')
                .input('idEstado', sql.TinyInt, 5)
                .input('comentario', sql.NVarChar(sql.MAX), comentario)
                .query(`EXEC notassimples.peticiones_historia_new 
                        @idPeticion, @idVersion, @idUsuario, @idEstado, @comentario`);
            console.log(`Historial insertado para idPeticion: ${idPeticion}, idVersion: ${idVersion}`);
            logAction(`Historia DBF: idPeticion: ${idPeticion}, idVersion: ${idVersion}`);
        } catch (error) {
            console.error(`Error al ejecutar peticiones_historia_new: ${error.message}`);
            logAction(`Error al ejecutar peticiones_historia_new: ${error.message}`);
        }
    } catch (err) {
        console.error('Error al modificar el archivo DBF:', err);
    }
}

// -------------------------------------------------------
// 7) Funciones de envío de XML (Titular / IDUFIR / Finca / Reenvío)
// -------------------------------------------------------

// 7.1) fetchPendingRequests
async function fetchPendingRequests() {
    let resultadosTitular = [];
    let resultadosIDUFIR = [];
    let resultadosFinca = [];
    let resultadosReenvio = [];

    try {
        // Seleccionar peticiones con idEstado=1
        const peticiones = await pool.request().query(`
            SELECT idPeticion, idVersion, idUsuario 
            FROM peticiones 
            WHERE idEstado = 1
        `);

        for (let i = 0; i < peticiones.recordset.length; i++) {
            const { idPeticion, idVersion, idUsuario } = peticiones.recordset[i];
            const datosSolicitud = await pool.request()
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    SELECT * FROM datosSolicitud 
                    WHERE idPeticion = @idPeticion AND idVersion = @idVersion
                `);

            if (datosSolicitud.recordset.length > 0) {
                const row = datosSolicitud.recordset[0];
                if (row.idTipoSolicitud === 1) {
                    resultadosFinca.push({
                        codigoRegistro: row.codigoRegistro,
                        municipio: row.municipio,
                        provincia: row.provincia,
                        seccion: row.seccion,
                        finca: row.finca,
                        observaciones: row.observaciones,
                        idPeticion,
                        idVersion,
                        idUsuario
                    });
                }
                else if (row.idTipoSolicitud === 2) {
                    resultadosTitular.push({
                        nifTitular: row.nifTitular,
                        observaciones: row.observaciones,
                        idPeticion,
                        idVersion,
                        idUsuario
                    });
                }
                else if (row.idTipoSolicitud === 3) {
                    resultadosIDUFIR.push({
                        IDUFIR: row.IDUFIR,
                        observaciones: row.observaciones,
                        idPeticion,
                        idVersion,
                        idUsuario
                    });
                }
            }
        }

        // Seleccionar peticiones con idEstado=6 (pendiente de reenvío)
        const peticionesReenvio = await pool.request().query(`
            SELECT idPeticion, idVersion, idCorpme 
            FROM peticiones 
            WHERE idEstado = 6
        `);

        for (let i = 0; i < peticionesReenvio.recordset.length; i++) {
            const { idPeticion, idVersion, idCorpme } = peticionesReenvio.recordset[i];
            resultadosReenvio.push({
                idCorpme, 
                idPeticion, 
                idVersion
            });
        }

        // Logs
        if (resultadosFinca.length > 0) {
            console.log("Resultados de finca:", resultadosFinca);
            logAction(`Resultados finca: ${JSON.stringify(resultadosFinca)}`);
        }
        if (resultadosTitular.length > 0) {
            console.log("Resultados titulares:", resultadosTitular);
            logAction(`Resultados titular: ${JSON.stringify(resultadosTitular)}`);
        }
        if (resultadosIDUFIR.length > 0) {
            console.log("Resultados IDUFIR:", resultadosIDUFIR);
            logAction(`Resultados IDUFIR: ${JSON.stringify(resultadosIDUFIR)}`);
        }
        if (resultadosReenvio.length > 0) {
            console.log("Resultados Reenvío:", resultadosReenvio);
            logAction(`Resultados Reenvío: ${JSON.stringify(resultadosReenvio)}`);
        }

        return { resultadosTitular, resultadosIDUFIR, resultadosFinca, resultadosReenvio };
    } catch (err) {
        console.error('Error en fetchPendingRequests:', err);
        logAction(`Error en fetchPendingRequests: ${err.message}`);
        throw err;
    }
}

// 7.2) sendXMLxTitular
async function sendXMLxTitular(resultados) {
    for (let data of resultados) {
        const { nifTitular, observaciones, idPeticion, idVersion, idUsuario } = data;
        const xml = fs.readFileSync('./xml/peticion_x_titular.xml', 'utf-8');
        try {
            const parsedXml = await xml2js.parseStringPromise(xml);
            // Credenciales
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].entidad[0] = CREDENCIALES.ENTIDAD;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].grupo[0] = CREDENCIALES.GRUPO;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].usuario[0] = CREDENCIALES.USUARIO;
            
            // Obtener email del usuario en BBDD
            const resultEmail = await pool.request()
                .input('idUsuario', sql.VarChar(20), idUsuario)
                .query(`SELECT notassimples.get_email_usuario(@idUsuario) AS email`);
            const email = resultEmail.recordset[0]?.email || 'joseluis.martin@uah.es';
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = email;

            // Datos de la petición
            parsedXml['corpme-floti'].peticiones[0].peticion[0].titular[0].nif[0] = nifTitular;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].referencia = `RT_${idPeticion}_${idVersion}`;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].observaciones[0] = observaciones;

            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml_enviados/peticion_x_titular_${idPeticion}_${idVersion}.xml`, newXml);

            // Guardar XML en peticiones
            await pool.request()
                .input('xmlData', sql.NVarChar(sql.MAX), newXml)
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    UPDATE peticiones 
                    SET xml_peticion=@xmlData 
                    WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                `);
            console.log(`XML guardado para peticion ${idPeticion}, version ${idVersion}`);

            // Enviar a CORPME
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };
            const response = await instance(options);
            if (response.data) {
                logAction(`Acuse recibido ok x Titular, Peticion ${idPeticion}, version ${idVersion}`);
                // Guardar acuse
                const now = new Date();
                const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}-${now.getMilliseconds()}`;
                const fileName = `./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`;
                fs.writeFileSync(fileName, response.data);

                const receiptXml = await xml2js.parseStringPromise(response.data);
                await handleReceipt(receiptXml, idPeticion, idVersion); // <-- Ojo con await
            }
        } catch (error) {
            manejarAxiosError(error, idPeticion, idVersion, 'x Titular');
        }
    }
}

// 7.3) sendXMLxIDUFIR
async function sendXMLxIDUFIR(resultados) {
    for (let data of resultados) {
        const { IDUFIR, observaciones, idPeticion, idVersion, idUsuario } = data;
        const xml = fs.readFileSync('./xml/peticion_x_idufir.xml', 'utf-8');
        try {
            const parsedXml = await xml2js.parseStringPromise(xml);
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].entidad[0] = CREDENCIALES.ENTIDAD;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].grupo[0] = CREDENCIALES.GRUPO;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].usuario[0] = CREDENCIALES.USUARIO;

            // Email
            const resultEmail = await pool.request()
                .input('idUsuario', sql.VarChar(20), idUsuario)
                .query(`SELECT notassimples.get_email_usuario(@idUsuario) AS email`);
            const email = resultEmail.recordset[0]?.email || 'joseluis.martin@uah.es';
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = email;

            // Datos de la petición
            parsedXml['corpme-floti'].peticiones[0].peticion[0].idufir[0] = IDUFIR;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].observaciones[0] = observaciones;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].referencia = `RF_${idPeticion}_${idVersion}`;

            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml_enviados/peticion_x_idufir_${idPeticion}_${idVersion}.xml`, newXml);

            // Guardar XML
            await pool.request()
                .input('xmlData', sql.NVarChar(sql.MAX), newXml)
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    UPDATE peticiones 
                    SET xml_peticion=@xmlData 
                    WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                `);

            // POST
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };
            const response = await instance(options);
            if (response.data) {
                logAction(`Acuse recibido ok x IDUFIR, Peticion ${idPeticion}, version ${idVersion}`);
                const now = new Date();
                const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}-${now.getMilliseconds()}`;
                const fileName = `./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`;
                fs.writeFileSync(fileName, response.data);
                const receiptXml = await xml2js.parseStringPromise(response.data);
                await handleReceipt(receiptXml, idPeticion, idVersion);
            }
        } catch (error) {
            manejarAxiosError(error, idPeticion, idVersion, 'x IDUFIR');
        }
    }
}

// 7.4) sendXMLxFinca
async function sendXMLxFinca(resultados) {
    for (let data of resultados) {
        const { codigoRegistro, municipio, provincia, seccion, finca, observaciones, idPeticion, idVersion, idUsuario } = data;
        const xml = fs.readFileSync('./xml/peticion_x_finca.xml', 'utf-8');
        try {
            const parsedXml = await xml2js.parseStringPromise(xml);
            // Credenciales
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].entidad[0] = CREDENCIALES.ENTIDAD;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].grupo[0] = CREDENCIALES.GRUPO;
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].usuario[0] = CREDENCIALES.USUARIO;

            // Email
            const resultEmail = await pool.request()
                .input('idUsuario', sql.VarChar(20), idUsuario)
                .query(`SELECT notassimples.get_email_usuario(@idUsuario) AS email`);
            const email = resultEmail.recordset[0]?.email || 'joseluis.martin@uah.es';
            parsedXml['corpme-floti'].peticiones[0].credenciales[0].email[0] = email;

            // Datos registrales
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].registro[0] = parseInt(codigoRegistro, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].municipio[0] = parseInt(municipio, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].provincia[0] = parseInt(provincia, 10);
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].seccion[0] = parseInt(seccion, 10);

            // Finca / subfinca
            let [fincaValue, subfincaValue] = [null, null];
            if (finca.includes('/')) {
                const [firstPart, secondPart] = finca.split('/');
                fincaValue = parseInt(firstPart, 10);
                subfincaValue = secondPart;
            } else {
                fincaValue = parseInt(finca, 10);
            }
            parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].finca[0] = fincaValue;
            if (subfincaValue) {
                parsedXml['corpme-floti'].peticiones[0].peticion[0]['datos-registrales'][0].subfinca = [ subfincaValue ];
            }

            // Observaciones
            parsedXml['corpme-floti'].peticiones[0].peticion[0].observaciones[0] = observaciones;
            parsedXml['corpme-floti'].peticiones[0].peticion[0].referencia = `RF_${idPeticion}_${idVersion}`;

            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml_enviados/peticion_x_finca_${idPeticion}_${idVersion}.xml`, newXml);

            // Guardar XML
            await pool.request()
                .input('xmlData', sql.NVarChar(sql.MAX), newXml)
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    UPDATE peticiones 
                    SET xml_peticion=@xmlData 
                    WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                `);

            // POST
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };
            const response = await instance(options);
            if (response.data) {
                logAction(`Acuse recibido ok x Finca, Peticion ${idPeticion}, version ${idVersion}`);
                const now = new Date();
                const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}-${now.getMilliseconds()}`;
                const fileName = `./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}_${timestamp}.xml`;
                fs.writeFileSync(fileName, response.data);
                const receiptXml = await xml2js.parseStringPromise(response.data);
                await handleReceipt(receiptXml, idPeticion, idVersion);
            }
        } catch (error) {
            manejarAxiosError(error, idPeticion, idVersion, 'x Finca');
        }
    }
}

// 7.5) sendXMLReenvio
async function sendXMLReenvio(resultados) {
    for (let data of resultados) {
        const { idCorpme, idPeticion, idVersion } = data;
        const xmlTemplate = fs.readFileSync('./xml/plantilla_reenvio.xml', 'utf-8');
        try {
            const parsedXml = await xml2js.parseStringPromise(xmlTemplate);
            parsedXml['corpme-floti'].reenvio[0].identificador[0] = idCorpme;

            const newXml = builder.buildObject(parsedXml);
            fs.writeFileSync(`./xml_enviados/peticion_reenvio_${idPeticion}_${idVersion}.xml`, newXml);

            // Guardar XML
            await pool.request()
                .input('xmlData', sql.NVarChar(sql.MAX), newXml)
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    UPDATE peticiones
                    SET xml_peticion=@xmlData
                    WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                `);

            // POST
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml' },
                data: newXml,
                url: url,
            };
            const response = await instance(options);
            if (response.data) {
                logAction(`Acuse recibido ok en Reenvío, Peticion ${idPeticion}, version ${idVersion}`);
                fs.writeFileSync(`./xml_recibidos/acuseRecibido_${idPeticion}_${idVersion}.xml`, response.data);
                const receiptXml = await xml2js.parseStringPromise(response.data);

                // En reenvíos, puede venir directamente la nota simple en "respuesta"
                if (receiptXml?.['corpme-floti']?.respuesta) {
                    await processReenvioCorpmeFloti(receiptXml, idPeticion, idVersion);
                }
                else if (receiptXml?.['corpme-floti']?.error) {
                    // Procesar error en reenvío
                    const errorNode = receiptXml['corpme-floti'].error[0];
                    const codigoError = errorNode['$']?.codigo || null;
                    const errorText = errorNode['_'] || 'Sin info adicional';

                    const xmlStringError = builder.buildObject(receiptXml);
                    try {
                        await pool.request()
                            .input('xmlRespuesta', sql.NVarChar(sql.MAX), xmlStringError)
                            .input('idCorpme', sql.VarChar(50), idCorpme)
                            .input('idPeticion', sql.Int, idPeticion)
                            .input('idVersion', sql.SmallInt, idVersion)
                            .query(`
                                UPDATE peticiones SET xml_respuesta=@xmlRespuesta 
                                WHERE idCorpme=@idCorpme AND idPeticion=@idPeticion AND idVersion=@idVersion
                            `);

                        await pool.request()
                            .input('codigoError', sql.Int, codigoError)
                            .input('idCorpme', sql.VarChar(50), idCorpme)
                            .input('idPeticion', sql.Int, idPeticion)
                            .input('idVersion', sql.SmallInt, idVersion)
                            .query(`
                                UPDATE peticiones 
                                SET IdEstado=7, idRespuesta=@codigoError 
                                WHERE idCorpme=@idCorpme AND idPeticion=@idPeticion AND idVersion=@idVersion
                            `);

                        const comentario = errorText;
                        const historiaRequest = pool.request();
                        historiaRequest.input('idPeticion', sql.Int, idPeticion);
                        historiaRequest.input('idVersion', sql.SmallInt, idVersion);
                        historiaRequest.input('idUsuario', sql.VarChar(20), 'CORPME');
                        historiaRequest.input('idEstado', sql.TinyInt, 7);
                        historiaRequest.input('comentario', sql.NVarChar(sql.MAX), comentario);
                        await historiaRequest.query(`
                            EXEC notassimples.peticiones_historia_new 
                                @idPeticion, @idVersion, @idUsuario, @idEstado, @comentario
                        `);

                        logAction(`Error en respuesta reenvío: ${comentario}`);
                    } catch (err) {
                        console.error('(Reenvío) Error al procesar respuesta de error:', err);
                        logAction('(Reenvío) Error al procesar respuesta de error');
                    }
                }
            }
        } catch (error) {
            manejarAxiosError(error, idPeticion, idVersion, 'Reenvío');
        }
    }
}

// 7.6) Manejador de errores de Axios
function manejarAxiosError(error, idPeticion, idVersion, tipoPeticion) {
    if (error.code === 'ECONNABORTED') {
        console.error(`Timeout para ID: ${idPeticion}, version: ${idVersion}, tipo: ${tipoPeticion}`);
    } else if (error.response) {
        console.error(`Respuesta de servidor (status ${error.response.status}) en ID: ${idPeticion}, version: ${idVersion}, tipo: ${tipoPeticion}`);
    } else if (error.request) {
        console.error(`No se recibió respuesta, ID: ${idPeticion}, version: ${idVersion}, tipo: ${tipoPeticion}`);
    } else {
        console.error(`Error al configurar petición, ID: ${idPeticion}, version: ${idVersion}, tipo: ${tipoPeticion}`);
    }
    console.error('Información del error:', error.message);
    logAction(`Error al lanzar petición ${tipoPeticion}: ${error.message}`);
}

// ----------------------------------------
// 8) Funciones para manejar los "acuses"
// ----------------------------------------
async function handleReceipt(receipt, idPeticion, idVersion) {
    let comentario = '';
    let idUsuario = '';
    let idEstado = 2; // 2 => éxito por defecto

    try {
        // 1) Buscar idUsuario en la tabla peticiones
        const resultUser = await pool.request()
            .input('idPeticion', sql.Int, idPeticion)
            .input('idVersion', sql.SmallInt, idVersion)
            .query('SELECT idUsuario FROM peticiones WHERE idPeticion=@idPeticion AND idVersion=@idVersion');
        if (resultUser.recordset.length > 0) {
            idUsuario = "CORPME"; // Forzamos "CORPME" o usas resultUser.recordset[0].idUsuario
        } else {
            logAction(`No se encontró registro para Peticion ${idPeticion}, version ${idVersion}`);
            throw new Error(`No se encontró registro para ${idPeticion}, ${idVersion}`);
        }

        // 2) Verificar si la respuesta general contiene un error
        if (receipt?.['corpme-floti']?.error) {
            const codigo = receipt['corpme-floti'].error[0]['$'].codigo;
            const mensaje = receipt['corpme-floti'].error[0]['_'];
            console.error(`Error general en XML: ${mensaje}, Código ${codigo}`);
            logAction(`Error general en XML: ${mensaje}, Código ${codigo}`);
            idEstado = 3;
            comentario = `Petición recibida KO: idError=${codigo} | ${mensaje}`;
            // Actualizar la petición
            await pool.request()
                .input('estado', sql.TinyInt, 3)
                .input('codigo', sql.Int, codigo)
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    UPDATE peticiones 
                    SET idEstado=@estado, idError=@codigo 
                    WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                `);
        }
        // 3) Si hay "acuses"
        else if (receipt?.['corpme-floti']?.acuses?.[0]?.acuse) {
            const acuse = receipt['corpme-floti'].acuses[0].acuse[0];
            // 3.1) Si acuse contiene error
            if (acuse.error) {
                const codigo = acuse.error[0]['$'].codigo;
                const mensaje = acuse.error[0]['_'];
                console.error(`Error específico en el acuse: ${mensaje}, Código ${codigo}`);
                logAction(`Error específico en acuse: ${mensaje}, Código ${codigo}`);
                idEstado = 3;
                comentario = `Petición recibida KO: idError=${codigo} | ${mensaje}`;
                await pool.request()
                    .input('estado', sql.TinyInt, 3)
                    .input('codigo', sql.Int, codigo)
                    .input('idPeticion', sql.Int, idPeticion)
                    .input('idVersion', sql.SmallInt, idVersion)
                    .query(`
                        UPDATE peticiones 
                        SET idEstado=@estado, idError=@codigo 
                        WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                    `);
            } else {
                // 3.2) Si no hay error en acuse
                await pool.request()
                    .input('idPeticion', sql.Int, idPeticion)
                    .input('idVersion', sql.SmallInt, idVersion)
                    .query(`
                        UPDATE peticiones 
                        SET idEstado=2, idError=NULL 
                        WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                    `);
                console.log(`Estado actualizado a 2 (OK) para peticion ${idPeticion}`);
                logAction(`Estado 2 OK peticion ${idPeticion}, version ${idVersion}`);

                if (acuse.identificador) {
                    for (const identificador of acuse.identificador) {
                        await pool.request()
                            .input('identificador', sql.VarChar(50), identificador)
                            .input('idPeticion', sql.Int, idPeticion)
                            .input('idVersion', sql.SmallInt, idVersion)
                            .query(`
                                UPDATE peticiones
                                SET idCorpme=@identificador
                                WHERE idPeticion=@idPeticion AND idVersion=@idVersion
                            `);
                        logAction(`Identificador act. a ${identificador} para pet ${idPeticion}, ver ${idVersion}`);
                        comentario = `Petición recibida OK: idCorpme=${identificador}`;
                    }
                }
            }
        }

        // 4) Insertar historial
        await pool.request()
            .input('idPeticion', sql.Int, idPeticion)
            .input('idVersion', sql.SmallInt, idVersion)
            .input('idUsuario', sql.VarChar(20), idUsuario)
            .input('idEstado', sql.TinyInt, idEstado)
            .input('comentario', sql.NVarChar(sql.MAX), comentario)
            .query(`
                EXEC notassimples.peticiones_historia_new
                @idPeticion, @idVersion, @idUsuario, @idEstado, @comentario
            `);

        logAction(`Historia actualizada tras receipt. idPeticion=${idPeticion}, version=${idVersion}`);
    } catch (err) {
        console.error('Error handleReceipt:', err);
        logAction(`Error handleReceipt: ${err}`);
    }
}

// --------------------------------------------------------------------
// 9) Proceso especial para reenvío (cuando llega la nota en "respuesta")
// --------------------------------------------------------------------
async function processReenvioCorpmeFloti(xmlData, idPeticion, idVersion) {
    const corpmeFloti = xmlData['corpme-floti'];
    if (corpmeFloti && corpmeFloti.respuesta && corpmeFloti.respuesta.length > 0) {
        const respuesta = corpmeFloti.respuesta[0];
        const identificador = respuesta.identificador ? respuesta.identificador[0] : null;
        const informacion = respuesta.informacion ? respuesta.informacion[0] : null;
        
        const tipoRespuesta = respuesta['tipo-respuesta'] ? respuesta['tipo-respuesta'][0] : null;
        const codigoTipoRespuesta = tipoRespuesta ? tipoRespuesta['$'].codigo : null;
        const textoTipoRespuesta = tipoRespuesta ? tipoRespuesta['_'] : null;

        // Copia del XML para guardar sin PDF ni firma
        let xmlDataSinPdfNiFirma = JSON.parse(JSON.stringify(xmlData));

        // Eliminar ds:Signature
        if (xmlDataSinPdfNiFirma['corpme-floti']['ds:Signature']) {
            delete xmlDataSinPdfNiFirma['corpme-floti']['ds:Signature'];
        }
        // Eliminar el fichero PDF
        if (xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion?.[0].fichero) {
            delete xmlDataSinPdfNiFirma['corpme-floti'].respuesta[0].informacion[0].fichero;
        }
        // Guardar en la base de datos
        try {
            const xmlStringSinPdfNiFirma = builder.buildObject(xmlDataSinPdfNiFirma);
            await pool.request()
                .input('xmlRespuesta', sql.NVarChar(sql.MAX), xmlStringSinPdfNiFirma)
                .input('idCorpme', sql.VarChar(50), identificador)
                .input('idPeticion', sql.Int, idPeticion)
                .input('idVersion', sql.SmallInt, idVersion)
                .query(`
                    UPDATE peticiones 
                    SET xml_respuesta=@xmlRespuesta 
                    WHERE idCorpme=@idCorpme 
                    AND idPeticion=@idPeticion 
                    AND idVersion=@idVersion
                `);
        } catch (err) {
            console.error('(Reenvío) Error al guardar xml sin pdf:', err);
            return;
        }

        // Guardar XML completo en un archivo local
        const xmlString = builder.buildObject(xmlData);
        fs.writeFile(
          `./xml/respuestaRecibidaReenvio_${idPeticion}_${idVersion}_${identificador}.xml`,
          xmlString, 
          err => {
            if (err) {
                console.error('(Reenvío) Error al guardar XML:', err);
                return;
            }
            console.log(`(Reenvío) Archivo XML guardado para pet ${idPeticion}, ver ${idVersion}, corpme ${identificador}`);
            logAction(`(Reenvío) Archivo XML guardado para ${identificador}`);
          }
        );

        if (!tipoRespuesta) {
            logAction('(Reenvío) Tipo de respuesta no encontrado');
            return;
        }

        // Procesar PDF, etc.
        if (codigoTipoRespuesta === '11') {
            let ficheroPdfBase64;
            if (informacion?.fichero?.[0]?._) {
                ficheroPdfBase64 = informacion.fichero[0]['_'];
                const pdfBuffer = Buffer.from(ficheroPdfBase64, 'base64');
                try {
                    await pool.request()
                        .input('pdf', sql.VarBinary(sql.MAX), pdfBuffer)
                        .input('idCorpme', sql.VarChar(50), identificador)
                        .input('idPeticion', sql.Int, idPeticion)
                        .input('idVersion', sql.SmallInt, idVersion)
                        .input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta)
                        .query(`
                            UPDATE peticiones 
                            SET pdf=@pdf, IdEstado=5, idRespuesta=@codigoTipoRespuesta 
                            WHERE idCorpme=@idCorpme 
                            AND idPeticion=@idPeticion 
                            AND idVersion=@idVersion
                        `);
                    console.log('(Reenvío síncrono) PDF guardado con éxito');
                    // Insertar historia
                    const comentario = 'Recepción de NS por GT';
                    await pool.request()
                        .input('idPeticion', sql.Int, idPeticion)
                        .input('idVersion', sql.SmallInt, idVersion)
                        .input('idUsuario', sql.VarChar(20), 'CORPME')
                        .input('idEstado', sql.TinyInt, 5)
                        .input('comentario', sql.NVarChar(sql.MAX), comentario)
                        .query(`
                            EXEC notassimples.peticiones_historia_new
                            @idPeticion, @idVersion, @idUsuario, @idEstado, @comentario
                        `);
                    logAction(`PDF nota simple reenviada guardado (idCorpme=${identificador})`);
                } catch (err) {
                    console.error('(Reenvío) Error al guardar PDF:', err);
                    logAction(`(Reenvío) Error al guardar PDF: ${err}`);
                }
            }
        } else if (codigoTipoRespuesta === '12') {
            // Nota simple negativa
            try {
                await pool.request()
                    .input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta)
                    .input('idCorpme', sql.VarChar(50), identificador)
                    .input('idPeticion', sql.Int, idPeticion)
                    .input('idVersion', sql.SmallInt, idVersion)
                    .query(`
                        UPDATE peticiones 
                        SET IdEstado=7, idRespuesta=@codigoTipoRespuesta 
                        WHERE idCorpme=@idCorpme
                        AND idPeticion=@idPeticion 
                        AND idVersion=@idVersion
                    `);
                const comentario = informacion?.texto?.[0] || 'Sin información adicional';
                await pool.request()
                    .input('idPeticion', sql.Int, idPeticion)
                    .input('idVersion', sql.SmallInt, idVersion)
                    .input('idUsuario', sql.VarChar(20), 'CORPME')
                    .input('idEstado', sql.TinyInt, 7)
                    .input('comentario', sql.NVarChar(sql.MAX), comentario)
                    .query(`
                        EXEC notassimples.peticiones_historia_new 
                        @idPeticion, @idVersion, @idUsuario, @idEstado, @comentario
                    `);
                logAction(`(Reenvío) Respuesta negativa para ${identificador}: ${comentario}`);
            } catch (err) {
                console.error('(Reenvío) Error al procesar NS negativa:', err);
                logAction(`(Reenvío) Error al procesar NS negativa: ${err}`);
            }
        } else {
            // Resto de casos de denegación
            try {
                await pool.request()
                    .input('codigoTipoRespuesta', sql.Int, codigoTipoRespuesta)
                    .input('idCorpme', sql.VarChar(50), identificador)
                    .input('idPeticion', sql.Int, idPeticion)
                    .input('idVersion', sql.SmallInt, idVersion)
                    .query(`
                        UPDATE peticiones
                        SET IdEstado=7, idRespuesta=@codigoTipoRespuesta
                        WHERE idCorpme=@idCorpme 
                        AND idPeticion=@idPeticion
                        AND idVersion=@idVersion
                    `);
                const textoTipoRespuesta2 = informacion?.texto?.[0] || 'Sin información adicional';
                const comentario = `Petición denegada: code=${codigoTipoRespuesta}, ${textoTipoRespuesta2}`;
                await pool.request()
                    .input('idPeticion', sql.Int, idPeticion)
                    .input('idVersion', sql.SmallInt, idVersion)
                    .input('idUsuario', sql.VarChar(20), 'CORPME')
                    .input('idEstado', sql.TinyInt, 4)
                    .input('comentario', sql.NVarChar(sql.MAX), comentario)
                    .query(`
                        EXEC notassimples.peticiones_historia_new
                        @idPeticion, @idVersion, @idUsuario, @idEstado, @comentario
                    `);
                logAction(`(Reenvío) Petición denegada code=${codigoTipoRespuesta}, corpme=${identificador}`);
            } catch (err) {
                console.error('(Reenvío) Error al guardar denegación:', err);
                logAction(`(Reenvío) Error al guardar denegación: ${err}`);
            }
        }
    } else {
        logAction('(Reenvío) Formato XML inválido o faltante');
    }
}

// ----------------------------------------------
// 10) Procesar peticiones DBF en /procesar-peticiones-dbfs
// ----------------------------------------------
app.get('/procesar-peticiones-dbfs', async (req, res) => {
    try {
        const query = `
            SELECT TOP 5 T1.idDocumento, T1.idPeticion, T1.idVersion
            FROM tasadores.notassimples.peticiones T1
            WHERE T1.idRespuesta='1' AND T1.idEstado='5'
            AND NOT EXISTS (
                SELECT NULL 
                FROM tasadores.notassimples.peticiones_dbf T2 
                WHERE T1.idDocumento = T2.idDocumento
            )
            ORDER BY T1.idDocumento
        `;
        const result = await pool.request().query(query);
        const peticiones = result.recordset;

        if (peticiones.length === 0) {
            return res.status(200).send('No hay peticiones pendientes para procesar DBF.');
        }

        for (const pet of peticiones) {
            const { idPeticion, idVersion } = pet;
            try {
                await modificarDBFConPython(idPeticion, idVersion);
                console.log(`DBF ok para idPeticion=${idPeticion}, ver=${idVersion}`);
                logAction(`DBF ok: idPeticion=${idPeticion}, ver=${idVersion}`);
            } catch (error) {
                console.error(`Error DBF en idPeticion=${idPeticion}, ver=${idVersion}:`, error);
                logAction(`Error DBF en idPeticion=${idPeticion}, ver=${idVersion}: ${error.message}`);
            }
        }
        res.status(200).send('Peticiones DBF procesadas.');
    } catch (error) {
        console.error('Error en /procesar-peticiones-dbfs:', error);
        logAction(`Error en /procesar-peticiones-dbfs: ${error.message}`);
        res.status(500).send('Error al procesar las peticiones DBF.');
    }
});

// -------------------------------------------
// 11) POST /spnts - Recibir respuestas CORPME
// -------------------------------------------
app.post('/spnts', async (req, res) => {
    try {
        const xmlData = req.body;
        if (xmlData['corpme-floti']) {
            await processCorpmeFloti(xmlData, res);
        } else if (xmlData['corpme-floti-facturacion']) {
            await processCorpmeFlotiFacturacion(xmlData, res);
        } else {
            res.status(400).send('XML inválido o faltante');
            logAction('Respuesta recibida con XML inválido');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al procesar la respuesta');
        logAction(`Error al procesar respuesta: ${error}`);
    }
});

// 11.1) processCorpmeFloti
async function processCorpmeFloti(xmlData, res) {
    const corpmeFloti = xmlData['corpme-floti'];
    if (corpmeFloti?.respuesta?.length > 0) {
        // ... (toda tu lógica original) ...
        // He aquí solo un extracto simplificado
        // NOTA: Reemplaza todas las llamadas a sql.connect/config => ya no hacen falta
        // Usa pool.request() para los queries
        // Envía confirmación:

        // ... tu lógica ...
        // Por claridad, no repetimos todo el switch de tipo-respuesta. 
        // Basta con que recuerdes que ahora usas: 
        //   await pool.request().query(...)

        const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok.xml'), 'utf8');
        res.set('Content-Type', 'text/xml');
        res.send(confirmacionXml);
    } else {
        res.status(400).send('Formato de XML inválido (corpme-floti)');
        logAction('Formato de XML inválido (corpme-floti)');
    }
}

// 11.2) processCorpmeFlotiFacturacion
async function processCorpmeFlotiFacturacion(xmlData, res) {
    const facturacion = xmlData['corpme-floti-facturacion'];
    const facturacionData = facturacion.facturacion ? facturacion.facturacion[0] : null;

    // Guardar archivo en disco
    const xmlString = builder.buildObject(xmlData);
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const fileName = `GTREGAPP_${year}_${month}_${day}_${seconds}.xml`;
    fs.writeFile(`./xml_facturas_recibidas/${fileName}`, xmlString, err => {
        if (err) {
            console.error('Error al guardar facturación:', err);
            res.status(500).send('Error al guardar XML de facturación');
            return;
        }
        console.log('Archivo XML de facturación guardado');
        logAction('Archivo XML de facturación guardado');
    });

    if (facturacionData) {
        // Se envía la confirmación "ok" de inmediato para no causar timeouts
        const confirmacionXml = fs.readFileSync(path.join(__dirname, 'xml/corpme_floti_ok_fact.xml'), 'utf8');
        res.set('Content-Type', 'text/xml');
        res.send(confirmacionXml);

        // Insertar en tablas de facturación...
        try {
            // 1) Insert en facturacion_factura
            const idFactura = facturacion.$['id'];
            const idUsuario = facturacionData.$['id'];
            const importeBase = facturacionData.$['importe-base'];
            const importeImpuesto = facturacionData.$['importe-impuesto'];
            const periodoInicio = facturacionData.$['periodo-inicio'];
            const periodoFin = facturacionData.$['periodo-fin'];

            const insertFactura = await pool.request()
                .input('id_factura', sql.VarChar(50), idFactura)
                .input('id_usuario', sql.VarChar(50), idUsuario)
                .input('importe_base', sql.Money, parseFloat(importeBase))
                .input('importe_impuesto', sql.Money, parseFloat(importeImpuesto))
                .input('periodo_inicio', sql.SmallDateTime, new Date(periodoInicio))
                .input('periodo_fin', sql.SmallDateTime, new Date(periodoFin))
                .query(`
                    INSERT INTO facturacion_factura (
                       "factura_idFactura", "factura_idUsuario", "factura_importe-base", 
                       "factura_importe-impuesto", "factura_periodo-inicio", "factura_periodo-fin"
                    )
                    OUTPUT INSERTED.factura_idTabla
                    VALUES (
                       @id_factura, @id_usuario, @importe_base, 
                       @importe_impuesto, @periodo_inicio, @periodo_fin
                    )
                `);
            const IdTabla = insertFactura.recordset[0].factura_idTabla;

            // 2) Recorrer facturacionData.factura
            for (let factura of facturacionData.factura) {
                // Extraer info principal
                const ejercicio = factura.$['ejercicio'];
                const fechaFactura = factura.$['fecha'];
                const numeroFactura = factura.$['numero'];
                const regimenCajaB = factura.$['regimen-caja'] === 'true';
                const regimenCaja = regimenCajaB ? 1 : 0;
                const serie = factura.$['serie'];

                // Emisor
                const emisor = factura.emisor?.[0]?.$ || {};
                let emisorNif = emisor['nif'] || '';
                emisorNif = emisorNif.padStart(9, '0'); // ejemplo
                let emisorCp = emisor['cp'] || '';
                emisorCp = emisorCp.padStart(5, '0');

                // ...
                const peticionBase = factura.importe?.[0]?.$['base'] || 0;
                const peticionImpuesto = factura.importe?.[0]?.$['impuesto'] || 0;
                const peticionIrpf = factura.importe?.[0]?.$['irpf'] || 0;

                // Buscar codigoRegistro si existe
                let codigoRegistro = 0;
                let descripcionEmplazamiento = 'Desconocido';
                if (emisorNif) {
                    const resultCodigo = await pool.request()
                        .input('emisor_nif', sql.VarChar(20), emisorNif)
                        .query(`
                            SELECT CodigoRegistro
                            FROM registros_emisor
                            WHERE NIFEmisor = @emisor_nif
                            GROUP BY CodigoRegistro
                            HAVING COUNT(*) = 1
                        `);
                    if (resultCodigo.recordset.length === 1) {
                        codigoRegistro = resultCodigo.recordset[0].CodigoRegistro;
                        // Descripción
                        const resultDescripcion = await pool.request()
                            .input('codReg', sql.Int, codigoRegistro)
                            .query(`
                                SELECT Descripcion
                                FROM registros_emplazamiento
                                WHERE CodigoRegistro=@codReg
                            `);
                        if (resultDescripcion.recordset.length === 1) {
                            descripcionEmplazamiento = `Registro Propiedad de ${resultDescripcion.recordset[0].Descripcion}`;
                        }
                    }
                }

                // Insert en facturacion_emisor
                await pool.request()
                    .input('factura_idTabla', sql.Int, IdTabla)
                    .input('codigo_registro', sql.Int, codigoRegistro)
                    .input('descripcion_emplazamiento', sql.VarChar(250), descripcionEmplazamiento)
                    .input('nif', sql.VarChar(20), emisorNif)
                    .input('nombre', sql.VarChar(250), emisor['nombre'] || '')
                    .input('domicilio', sql.VarChar(250), emisor['domicilio'] || '')
                    .input('municipio', sql.VarChar(250), emisor['municipio'] || '')
                    .input('provincia', sql.VarChar(50), emisor['provincia'] || '')
                    .input('cp', sql.VarChar(5), emisorCp)
                    .input('emisor_base', sql.Money, parseFloat(peticionBase))
                    .input('emisor_impuesto', sql.Money, parseFloat(peticionImpuesto))
                    .input('emisor_irpf', sql.Money, parseFloat(peticionIrpf))
                    .input('fecha_factura', sql.SmallDateTime, fechaFactura)
                    .input('ejercicio', sql.Int, ejercicio)
                    .input('serie', sql.VarChar(10), serie)
                    .input('numero', sql.VarChar(5), numeroFactura)
                    .input('regimen_caja', sql.Int, regimenCaja)
                    .query(`
                        INSERT INTO facturacion_emisor (
                          factura_idTabla, emisor_codigoRegistro, emisor_nombreRegistro, 
                          emisor_nif, emisor_nombre, emisor_domicilio, emisor_municipio, 
                          emisor_provincia, emisor_cp, emisor_base, emisor_impuesto, emisor_irpf, 
                          "emisor_fecha-factura", emisor_ejercicio, emisor_serie, emisor_numero, 
                          "emisor_regimen-caja"
                        )
                        VALUES (
                          @factura_idTabla, @codigo_registro, @descripcion_emplazamiento,
                          @nif, @nombre, @domicilio, @municipio,
                          @provincia, @cp, @emisor_base, @emisor_impuesto, @emisor_irpf,
                          @fecha_factura, @ejercicio, @serie, @numero, @regimen_caja
                        )
                    `);

                // Insertar peticiones
                const peticiones = Array.isArray(factura.peticion) ? factura.peticion : [factura.peticion];
                for (let pet of peticiones) {
                    if (!pet) continue;
                    const idPeticionCorpme = pet.$['id'];
                    const fecha = pet.$['fecha'];
                    const fechaRespuesta = pet.$['fecha-respuesta'];
                    const importeBasePeticion = pet.$['importe-base'];
                    const porcentajeImpuesto = pet.$['porcentaje-impuesto'];
                    const referencia = pet.$['referencia'];

                    await pool.request()
                        .input('factura_idTabla', sql.Int, IdTabla)
                        .input('emisor_codigoRegistro', sql.Int, codigoRegistro)
                        .input('emisor_nif', sql.VarChar(20), emisorNif)
                        .input('id_peticion', sql.VarChar(50), idPeticionCorpme)
                        .input('fecha', sql.SmallDateTime, new Date(fecha))
                        .input('fecha_respuesta', sql.SmallDateTime, new Date(fechaRespuesta))
                        .input('importe_base', sql.Money, parseFloat(importeBasePeticion))
                        .input('porcentaje_impuesto', sql.Decimal(5, 2), parseFloat(porcentajeImpuesto))
                        .input('referencia', sql.VarChar(50), referencia)
                        .query(`
                            INSERT INTO facturacion_peticion (
                                factura_idTabla, emisor_codigoRegistro, emisor_nif, 
                                peticion_idCorpme, "peticion_fecha-peticion", "peticion_fecha-respuesta", 
                                "peticion_importe-base", "peticion_porcentaje-impuesto", peticion_referencia
                            )
                            VALUES (
                                @factura_idTabla, @emisor_codigoRegistro, @emisor_nif,
                                @id_peticion, @fecha, @fecha_respuesta,
                                @importe_base, @porcentaje_impuesto, @referencia
                            )
                        `);
                }
            }

            logAction(`Datos de facturación almacenados con éxito. factura_idTabla=${IdTabla}`);
        } catch (err) {
            console.error('Error al guardar facturación en DB:', err);
            logAction(`Error al guardar facturación: ${err}`);
        }
    } else {
        res.status(400).send('XML de facturación inválido');
    }
}

// -------------------------------------------------------------
// 12) Arrancar servidor HTTPS con las credenciales .pfx
// -------------------------------------------------------------
const credentials = {
    pfx: fs.readFileSync(process.env.SSL_PFX_PATH),
    passphrase: process.env.SSL_PFX_PASSWORD
};

const httpsServer = https.createServer(credentials, app);
httpsServer.setTimeout(0);

// 13) Llamamos a connectDB() y luego listen
connectDB().then(() => {
    httpsServer.listen(port, () => {
        console.log(`Servidor HTTPS en https://localhost:${port}`);
        logAction(`Servidor iniciado en puerto ${port}`);
    });
});

// 14) Tareas programadas
function runFetchPendingRequests() {
    fetchPendingRequests()
        .then(data => {
            if (!data) return;
            if (data.resultadosTitular.length > 0)  sendXMLxTitular(data.resultadosTitular);
            if (data.resultadosIDUFIR.length > 0)   sendXMLxIDUFIR(data.resultadosIDUFIR);
            if (data.resultadosFinca.length > 0)    sendXMLxFinca(data.resultadosFinca);
            if (data.resultadosReenvio.length > 0)  sendXMLReenvio(data.resultadosReenvio);
        })
        .catch(console.error);
}

// Cada 20s busca peticiones pendientes
setInterval(runFetchPendingRequests, 20000);
