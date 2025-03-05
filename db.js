// db.js
require('dotenv').config();
const sql = require('mssql');

// 1) Configuración de la conexión
const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    options: {
        encrypt: false,       // Cambia a true en producción si se requiere cifrado
        enableArithAbort: true
    }
};

// 2) Crear el pool global
const pool = new sql.ConnectionPool(config);

// 3) Función para conectar el pool una sola vez
async function connectDB() {
    try {
        await pool.connect();
        console.log('Conexión establecida con SQL Server (pool global).');
    } catch (error) {
        console.error('Error al conectar con la base de datos:', error);
        throw error;
    }
}

// 4) Exportar sql, pool y la función de conectar
module.exports = {
    sql, 
    pool,
    connectDB
};
