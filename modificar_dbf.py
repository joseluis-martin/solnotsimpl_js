import sys
import dbf
import os
import shutil

# ─── Validación de argumentos (esto no deberia fallar)
def validar_argumentos():
    if len(sys.argv) < 6:
        print("Uso:     python3 modificar_dbf.py AÑO NUM_TAS SUP_TAS IMAGEN archivo.dbf")
        print("Ejemplo: python3 modificar_dbf.py 2024 306233 24 Nota_Simple.pdf 9.dbf")
        sys.exit(1)

# ─── Lógica principal ─────────────────────────────────────────────────────────
def main():
    validar_argumentos()

    IM_ANO_CLA  = str(sys.argv[1])
    IM_NUM_TAS  = str(sys.argv[2])
    IM_SUP_TAS  = sys.argv[3]          # Se convierte a numérico más abajo si hace falta
    IMAGEN      = sys.argv[4]
    new_dbf_file = sys.argv[5]

    original_dir  = 'dbf_original'
    generated_dir = 'dbfs_generados'

    dbf_file  = os.path.join(original_dir, 'I27244321.dbf')
    mem_file  = os.path.join(original_dir, 'I27244321.mem')

    # Verificar que el archivo origen existe
    if not os.path.exists(dbf_file):
        print(f"Error: no se encontró el archivo origen '{dbf_file}'")
        sys.exit(1)

    os.makedirs(generated_dir, exist_ok=True)
    new_dbf_file_path = os.path.join(generated_dir, new_dbf_file)

    table     = None
    new_table = None

    try:
        # ── Abrir tabla original SIN with (evita el doble open que causaba el bug) ──
        table = dbf.Table(dbf_file)
        table.open(dbf.READ_ONLY)

        # Limpiar la especificación de campos
        field_specs = [f.replace(' NULL', '') for f in table.structure()]

        # ── Crear y abrir la nueva tabla ──────────────────────────────────────
        new_table = dbf.Table(new_dbf_file_path, ';'.join(field_specs), dbf_type='vfp')
        new_table.open(dbf.READ_WRITE)

        # ── Copiar registros modificando los campos deseados ──────────────────
        for record in table:
            new_table.append()
            with new_table[-1] as rec:
                # Copiar todos los campos del registro original
                for field in table.field_names:
                    rec[field] = record[field]

                # Sobrescribir los campos solicitados
                rec["IM_ANO_CLA"] = IM_ANO_CLA
                rec["IM_NUM_TAS"] = IM_NUM_TAS
                rec["IMAGEN"]     = IMAGEN

                # Convertir IM_SUP_TAS al tipo correcto según el campo destino
                try:
                    rec["IM_SUP_TAS"] = float(IM_SUP_TAS)
                except (ValueError, dbf.FieldDataError):
                    rec["IM_SUP_TAS"] = IM_SUP_TAS

        # ── Cerrar ambas tablas explícitamente ────────────────────────────────
        table.close()
        new_table.close()

        # ── Renombrar .fpt → .FPT ─────────────────────────────────────────────
        fpt_path       = new_dbf_file_path.replace('.dbf', '.fpt')
        fpt_upper_path = new_dbf_file_path.replace('.dbf', '.FPT')
        if os.path.exists(fpt_path):
            os.rename(fpt_path, fpt_upper_path)
        else:
            print("Aviso: no se encontró el archivo .fpt generado.")

        # ── Copiar el .mem ────────────────────────────────────────────────────
        if os.path.exists(mem_file):
            new_mem_path = os.path.join(generated_dir, new_dbf_file.replace('.dbf', '.mem'))
            shutil.copy(mem_file, new_mem_path)
        else:
            print(f"Aviso: no se encontró el archivo .mem en '{mem_file}'.")

        print(f"✓ Archivo modificado y guardado como '{new_dbf_file}' con su .fpt correspondiente.")

    except dbf.DbfError as e:
        print(f"Error DBF: {e}")
        sys.exit(1)
    except PermissionError as e:
        print(f"Error de permisos: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Error inesperado ({type(e).__name__}): {e}")
        sys.exit(1)
    finally:
        # Garantizar cierre aunque ocurra una excepción
        if table and table.status != dbf.CLOSED:
            table.close()
        if new_table and new_table.status != dbf.CLOSED:
            new_table.close()

if __name__ == '__main__':
    main()