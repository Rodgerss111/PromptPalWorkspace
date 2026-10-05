use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub label: String,
    pub required: bool,
    pub default_value: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub schema_version: i64,
    pub name: String,
    pub category: String,
    pub context_text: String,
    pub task_text: String,
    pub format_text: String,
    pub variables: Vec<Variable>,
    pub is_built_in: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoreSnapshot {
    pub custom_templates: Vec<Template>,
    pub favorite_ids: Vec<String>,
    pub theme: String,
}

pub struct PersistenceManager {
    conn: Mutex<Connection>,
}

impl PersistenceManager {
    pub fn new(store_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&store_dir)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let db_path = store_dir.join("promptpal.db");
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let manager = Self {
            conn: Mutex::new(conn),
        };
        manager.initialize_schema()?;
        Ok(manager)
    }

    fn initialize_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS templates (
                id TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                context_text TEXT NOT NULL,
                task_text TEXT NOT NULL,
                format_text TEXT NOT NULL,
                variables TEXT NOT NULL,
                is_builtin INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
        Ok(())
    }

    pub fn load_snapshot(&self) -> Result<StoreSnapshot> {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT id, schema_version, name, category, context_text, task_text,
                    format_text, variables, is_builtin, created_at, updated_at
             FROM templates WHERE is_builtin = 0 ORDER BY created_at, id",
        )?;
        let templates = statement
            .query_map([], |row| {
                let variables: String = row.get(7)?;
                Ok(Template {
                    id: row.get(0)?,
                    schema_version: row.get(1)?,
                    name: row.get(2)?,
                    category: row.get(3)?,
                    context_text: row.get(4)?,
                    task_text: row.get(5)?,
                    format_text: row.get(6)?,
                    variables: serde_json::from_str(&variables).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            7,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    is_built_in: row.get::<_, i64>(8)? != 0,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        let favorite_ids = setting(&conn, "favoriteIds")?
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
            .unwrap_or_default();
        let theme = setting(&conn, "theme")?.unwrap_or_else(|| "light".to_string());

        Ok(StoreSnapshot {
            custom_templates: templates,
            favorite_ids,
            theme,
        })
    }

    pub fn save_snapshot(&self, snapshot: &StoreSnapshot) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM templates WHERE is_builtin = 0", [])?;
        for template in &snapshot.custom_templates {
            let variables = serde_json::to_string(&template.variables)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            tx.execute(
                "INSERT INTO templates
                    (id, schema_version, name, category, context_text, task_text,
                     format_text, variables, is_builtin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    name = excluded.name,
                    category = excluded.category,
                    context_text = excluded.context_text,
                    task_text = excluded.task_text,
                    format_text = excluded.format_text,
                    variables = excluded.variables,
                    updated_at = excluded.updated_at
                 WHERE templates.is_builtin = 0",
                params![
                    template.id,
                    template.schema_version,
                    template.name,
                    template.category,
                    template.context_text,
                    template.task_text,
                    template.format_text,
                    variables,
                    template.created_at,
                    template.updated_at,
                ],
            )?;
        }
        set_setting(&tx, "favoriteIds", &serde_json::to_string(&snapshot.favorite_ids).unwrap())?;
        set_setting(&tx, "theme", &snapshot.theme)?;
        tx.commit()?;
        Ok(())
    }

    pub fn reset_to_factory(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM templates WHERE is_builtin = 0", [])?;
        tx.execute("DELETE FROM settings", [])?;
        tx.commit()?;
        Ok(())
    }
}

fn setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}