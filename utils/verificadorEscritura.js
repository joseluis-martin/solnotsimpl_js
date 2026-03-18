const fs = require('fs');
const path = require('path');

const CARPETAS = [
    { ruta: './logs/', descripcion: 'Logs de aplicación' },
    { ruta: './uploads/', descripcion: 'Archivos subidos (temporal)' },
    { ruta: './xml/', descripcion: 'Plantillas XML y respuestas' },
    { ruta: './xml_enviados/', descripcion: 'XML de peticiones enviadas' },
    { ruta: './xml_recibidos/', descripcion: 'Acuses de recibo XML' },
    { ruta: './xml_facturas_recibidas/', descripcion: 'XML de facturación' }
];

function verificarCarpetasEscritura(logger) {
    logger.info('=== Verificando carpetas de escritura (escritura + borrado) ===');
    
    for (const carpeta of CARPETAS) {
        const timestamp = Date.now();
        const archivoPrueba = `.test_write_${timestamp}.tmp`;
        const rutaArchivo = path.join(carpeta.ruta, archivoPrueba);
        
        try {
            if (!fs.existsSync(carpeta.ruta)) {
                fs.mkdirSync(carpeta.ruta, { recursive: true });
                logger.info(`Carpeta creada: ${carpeta.ruta} (${carpeta.descripcion})`);
            }

            fs.writeFileSync(rutaArchivo, 'test', 'utf8');
            
            fs.unlinkSync(rutaArchivo);
            
            logger.info(`OK ${carpeta.ruta} - OK (escritura y borrado verificados) - ${carpeta.descripcion}`);
        } catch (err) {
            logger.error(`KO ${carpeta.ruta} - ERROR: ${err.message} - ${carpeta.descripcion}`);
            throw new Error(`No se puede escribir en ${carpeta.ruta}: ${err.message}`);
        }
    }
    
    logger.info('=== Verificacion de carpetas completada ===');
}

function logEscritura(logger, tipo, ruta, nombreArchivo) {
    logger.info(`Escribiendo archivo ${tipo}: ${ruta}${nombreArchivo}`);
}

module.exports = {
    verificarCarpetasEscritura,
    logEscritura,
    CARPETAS
};
