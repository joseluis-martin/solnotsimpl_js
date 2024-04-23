const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = 3000;

app.use(bodyParser.text({ type: '*/*' }));

app.post('/xmlpeticion', (req, res) => {
    console.log('XML recibido:', req.body);  // Muestra el XML recibido

    // Simula un acuse de recibo XML con múltiples identificador
    const acuseXML = `
    <corpme-floti xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.test.registradores.org/schema/floti/envio.xsd">
        <acuses id="acuses">
            <acuse>
                <identificador>Z16TF84T</identificador>
                <identificador>A24DF56H</identificador>
                <identificador>G78JK90L</identificador>
                <!-- Descomentar la siguiente línea para simular un error -->
                <!-- <error>7</error> -->
            </acuse>
        </acuses>
    </corpme-floti>
    `;
    res.send(acuseXML);  // Envía el acuse de recibo XML
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});

