import sys
import dbf
import os
import shutil

# python3 modificar_dbf.py 2024 306233 24 Nota_Simple_9_1_Z16TZ16T.pdf 9.dbf

# Obtener los argumentos desde la línea de comandos
IM_ANO_CLA = str(sys.argv[1])
IM_NUM_TAS = str(sys.argv[2])
IM_SUP_TAS = str(sys.argv[3])
IMAGEN = sys.argv[4]
new_dbf_file = sys.argv[5]

# Definir los directorios
original_dir = 'dbf_original'
generated_dir = 'dbfs_generados'

# Archivos de origen .dbf y .mem con sus rutas completas
dbf_file = os.path.join(original_dir, 'I27244321.dbf')
mem_file = os.path.join(original_dir, 'I27244321.mem')

# Verificar que el directorio de destino existe o crearlo
os.makedirs(generated_dir, exist_ok=True)

# Ruta completa para el archivo modificado
new_dbf_file_path = os.path.join(generated_dir, new_dbf_file)

# Usar el entorno with para abrir y manipular el archivo .dbf original en modo de solo lectura
with dbf.Table(dbf_file) as table:
    # Abrir la tabla en modo READ_ONLY para proteger el archivo original
    table.open(dbf.READ_ONLY)

    # Obtener la estructura de la tabla y ajustar si es necesario
    field_specs = [field.replace(' NULL', '') for field in table.structure()]

    # Crear una nueva tabla en el directorio de destino especificando el tipo como Visual FoxPro
    new_table = dbf.Table(new_dbf_file_path, ';'.join(field_specs), dbf_type='vfp')
    new_table.open(dbf.READ_WRITE)

    # Copiar y modificar cada registro en la nueva tabla sin alterar el archivo original
    for record in table:
        # Crear un nuevo registro en la nueva tabla
        new_table.append()  # Añade un nuevo registro vacío
        new_record = new_table[-1]  # Accede al último registro agregado

        # Modificar los campos deseados en el nuevo registro dentro de un contexto `with`
        with new_record as rec:
            # Copiar todos los campos del registro original al nuevo registro
            for field in table.field_names:
                rec[field] = record[field]
            
            # Modificar los campos deseados en el nuevo registro
            rec["IM_ANO_CLA"] = IM_ANO_CLA
            rec["IM_NUM_TAS"] = IM_NUM_TAS
            rec["IM_SUP_TAS"] = IM_SUP_TAS
            rec["IMAGEN"] = IMAGEN

    # Cerrar la nueva tabla
    new_table.close()

# Renombrar el archivo .fpt a .FPT en mayúsculas después de cerrar la nueva tabla
fpt_path = new_dbf_file_path.replace('.dbf', '.fpt')
fpt_upper_path = new_dbf_file_path.replace('.dbf', '.FPT')
if os.path.exists(fpt_path):
    os.rename(fpt_path, fpt_upper_path)

# Copiar el archivo .mem y renombrarlo para que coincida con el nuevo archivo en minúsculas
new_mem_file_path = os.path.join(generated_dir, new_dbf_file.replace('.dbf', '.mem'))
shutil.copy(mem_file, new_mem_file_path)

print(f"Archivo modificado y guardado como {new_dbf_file} con su .fpt correspondiente.")
