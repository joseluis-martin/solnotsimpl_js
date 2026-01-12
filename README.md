
# Manual de Usuario para Tasvalor eReg SysAdmin Dashboard

---

## Índice

1. [Descripción General de la Aplicación](#1-descripción-general-de-la-aplicación)
2. [Requisitos del Sistema](#2-requisitos-del-sistema)
3. [Preparación del Entorno de Servidor](#3-preparación-del-entorno-de-servidor)
4. [Instalación de Dependencias](#4-instalación-de-dependencias)
5. [Configuración del Entorno de Ejecución](#5-configuración-del-entorno-de-ejecución)
6. [Despliegue en Producción](#6-despliegue-en-producción)
7. [Iniciar y Detener la Aplicación](#7-iniciar-y-detener-la-aplicación)
8. [Monitoreo y Visualización de Logs](#8-monitoreo-y-visualización-de-logs)
9. [Mantenimiento y Actualización](#9-mantenimiento-y-actualización)
10. [Resolución de Problemas Comunes](#10-resolución-de-problemas-comunes)

---

## 1. Descripción General de la Aplicación

La aplicación **Tasvalor eReg SysAdmin Dashboard** es una herramienta de administración y monitoreo que permite:

- **Generación y gestión de archivos DBF**.
- **Consulta de logs** generados por la aplicación.
- **Estado del sistema y estadísticas en tiempo real**.

La aplicación está desarrollada en **Node.js** y utiliza un frontend en HTML y Bootstrap para la interfaz de usuario, mientras que ciertos scripts en **Python** son empleados para manipulación de archivos DBF. La base de datos es **Microsoft SQL Server**.

---

## 2. Requisitos del Sistema

### 2.1. Software

- **Windows Server 2016** o superior.
- **Node.js** (preferiblemente versión LTS para mayor estabilidad).
- **Python 3.x** (para ejecutar los scripts de manipulación DBF).
- **Microsoft SQL Server** y cliente de SQL configurados para aceptar conexiones externas.
- **Certificado SSL** en formato `.pfx` para asegurar las conexiones HTTPS.

### 2.2. Hardware

- **CPU**: Procesador Intel o AMD con al menos 4 núcleos.
- **RAM**: Mínimo 8 GB para asegurar una operación fluida.
- **Almacenamiento**: Al menos 20 GB disponibles, preferiblemente en una unidad SSD.

### 2.3. Conectividad

- **Puertos de red**:
  - El puerto `1433` debe estar habilitado en el firewall para conexiones a SQL Server.
  - El puerto `5999` (o el configurado en `.env`) para acceso a la aplicación desde el navegador.

---

## 3. Preparación del Entorno de Servidor

### 3.1. Actualización de Windows Server

1. Abre **Configuración** y selecciona **Actualización y seguridad**.
2. Haz clic en **Buscar actualizaciones** para descargar e instalar las últimas actualizaciones de seguridad.

### 3.2. Configuración de Roles y Características

1. Abre **Administrador de Servidores**.
2. Selecciona **Agregar roles y características**.
3. Asegúrate de que los siguientes componentes están instalados y activados:
   - **.NET Framework 4.7** o superior.
   - **Windows PowerShell**.

### 3.3. Configuración de Firewall

1. Abre **Panel de Control > Sistema y seguridad > Firewall de Windows > Configuración avanzada**.
2. Configura reglas de entrada para habilitar los puertos necesarios:
   - **1433**: para el servidor SQL.
   - **5999** (o el puerto especificado en el archivo `.env`): para el servidor de la aplicación Node.js.

---

## 4. Instalación de Dependencias

### 4.1. Instalación de Node.js

1. Descarga la última versión estable de Node.js desde [nodejs.org](https://nodejs.org/) y sigue las instrucciones del instalador.
2. Asegúrate de que Node.js se agrega al PATH del sistema. Para verificar, abre un símbolo del sistema y ejecuta:
   ```
   node -v
   npm -v
   ```

### 4.2. Instalación de Python

1. Descarga e instala Python desde [python.org](https://www.python.org/downloads/).
2. Durante la instalación, marca la casilla **Add Python to PATH**.
3. Verifica la instalación ejecutando:
   ```
   python --version
   pip --version
   ```

### 4.3. Instalación de Módulos Python

Instala la biblioteca `dbf` y otras dependencias necesarias ejecutando:
   ```
   pip install dbf
   ```

### 4.4. Instalación de Dependencias del Proyecto Node.js

Accede al directorio donde se encuentra `server.js` y ejecuta:
   ```
   cd C:\Users\desarrollo\solnotsimpl_js
   npm install
   ```

---

## 5. Configuración del Entorno de Ejecución

### 5.1. Configuración del Archivo .env

En el directorio raíz del proyecto, crea un archivo llamado `.env` y agrega las siguientes variables con valores adecuados:

   ```
   # Credenciales de base de datos
   DB_USER=notassimples
   DB_PASSWORD=************
   DB_SERVER=gt_sqlserver.gtasvalor.tasvalor.com
   DB_PORT=1433
   DB_DATABASE=**********

   # Certificados SSL
   SSL_PFX_PATH=./Certificado_SSL/2024/certificate.pfx
   SSL_PFX_PASSWORD=*******

   # Acceso a la web de administración
   ADMIN_USERNAME=********
   ADMIN_PASSWORD=******

   # Configuración de servidor
   PORT=5999
   ```

---

## 6. Despliegue en Producción

### 6.1. Configuración en el Programador de Tareas

Para automatizar la ejecución de la aplicación en el arranque del sistema:

1. Abre el **Programador de Tareas**.
2. Crea una nueva tarea y configura la ejecución al inicio del sistema.
3. En **Acciones**, usa `node.exe` y redirige la salida:
   ```
   C:\Program Files\nodejs\node.exe C:\Users\desarrollo\solnotsimpl_js\server.js
   ```

---

## 7. Iniciar y Detener la Aplicación

Para iniciar manualmente, ejecuta:
   ```
   node C:\Users\desarrollo\solnotsimpl_js\server.js
   ```

Para detener, usa el Administrador de Tareas para finalizar el proceso.

---

## 8. Monitoreo y Visualización de Logs

Accede a `https://localhost:5999/admin`. Usa la interfaz para revisar el estado y visualizar logs.

---

## 9. Mantenimiento y Actualización

Archiva logs antiguos y mantén actualizadas las dependencias de npm y pip.

---

## 10. Resolución de Problemas Comunes

- **Error de conexión a SQL Server**: Verifica las configuraciones en `.env` y el puerto de SQL.
- **Fallo en el Programador de Tareas**: Revisa el historial de tareas.

