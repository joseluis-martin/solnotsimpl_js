import sys
import dbf

# Obtener los argumentos desde la línea de comandos
IM_ANO_CLA = str(sys.argv[1])
IM_NUM_TAS = str(sys.argv[2])
IM_SUP_TAS = str(sys.argv[3])
IMAGEN = sys.argv[4]
new_dbf_file = sys.argv[5]

# Archivo de origen .dbf
dbf_file = 'I27244321.DBF'

# Usar el entorno with para abrir y manipular el archivo .dbf
with dbf.Table(dbf_file) as table:
    # Abrir la tabla en modo READ_WRITE
    table.open(dbf.READ_WRITE)

    # Obtener la estructura de la tabla y ajustar si es necesario
    field_specs = [field.replace(' NULL', '') for field in table.structure()]

    # Crear una nueva tabla especificando el tipo como Visual FoxPro para generar .fpt
    new_table = dbf.Table(new_dbf_file, ';'.join(field_specs), dbf_type='vfp')
    new_table.open(dbf.READ_WRITE)

    # Copiar y modificar cada registro en la nueva tabla
    for record in table:
        with record as rec:
            # Modificar los campos deseados con valores como strings
            rec.IM_ANO_CLA = IM_ANO_CLA
            rec.IM_NUM_TAS = IM_NUM_TAS
            rec.IM_SUP_TAS = IM_SUP_TAS
            rec.IMAGEN = IMAGEN
            # Añadir el registro modificado a la nueva tabla
            new_table.append(rec)

    # Cerrar la nueva tabla
    new_table.close()

print(f"Archivo modificado y guardado como {new_dbf_file} con su .fpt correspondiente.")
