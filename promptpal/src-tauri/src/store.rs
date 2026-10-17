use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::io;

#[cfg(test)]
use std::sync::Barrier;

#[derive(Debug, PartialEq)]
pub enum StoreError {
    DatabaseCorrupted,
    StaleData,
    LockedForRestoration,
    BuiltInImmutable,
    ValidationError(String),
    AccessDenied,
    Fatal(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::DatabaseCorrupted => write!(f, "CORRUPTED:Database integrity check failed."),
            StoreError::StaleData => write!(f, "The data was modified by another process. Please refresh."),
            StoreError::LockedForRestoration => write!(f, "Database is currently locked for restoration."),
            StoreError::BuiltInImmutable => write!(f, "Built-in templates cannot be edited. Please duplicate first."),
            StoreError::ValidationError(msg) => write!(f, "Validation failed: {}", msg),
            StoreError::AccessDenied => write!(f, "Database access denied. File may be locked."),
            StoreError::Fatal(msg) => write!(f, "FATAL: {}", msg),
        }
    }
}

impl Serialize for StoreError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        struct ErrorPayload<'a> {
            code: &'a str,
            message: String,
        }

        let (code, message) = match self {
            StoreError::DatabaseCorrupted => ("DATABASE_CORRUPTED", self.to_string()),
            StoreError::StaleData => ("STALE_DATA", self.to_string()),
            StoreError::LockedForRestoration => ("LOCKED_FOR_RESTORATION", self.to_string()),
            StoreError::BuiltInImmutable => ("BUILT_IN_IMMUTABLE", self.to_string()),
            StoreError::ValidationError(_) => ("VALIDATION_ERROR", self.to_string()),
            StoreError::AccessDenied => ("ACCESS_DENIED", self.to_string()),
            StoreError::Fatal(_) => ("FATAL", self.to_string()),
        };

        ErrorPayload { code, message }.serialize(serializer)
    }
}

// -----------------------------------------------------------------------------
// Data Models
// -----------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoreSnapshot {
    pub templates: Vec<Template>,
    pub preferences: Preferences,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub schema_version: u32,
    pub name: String,
    pub category: String,
    pub context_text: String,
    pub task_text: String,
    pub format_text: String,
    pub variables: Vec<Variable>, 
    pub is_built_in: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub label: String,
    pub required: bool,
    pub default_value: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub favorite_template_ids: Vec<String>, 
    pub shortcut: String,
    pub launch_at_startup: bool,
    pub icon_position: Option<Vec<i32>>, 
    pub icon_visible: bool,
    pub schema_version: u32,
    pub data_revision: u32,
}

// -----------------------------------------------------------------------------
// Canonical Built-ins & Syntax Validation
// -----------------------------------------------------------------------------

fn get_canonical_builtins() -> Vec<Template> {
    vec![
        Template {
            id: "builtin-learn-fundamentals".into(), schema_version: 1, name: "Learn fundamentals".into(), category: "Learning".into(),
            context_text: "I am a beginner studying this topic and want to understand the fundamentals.".into(),
            task_text: "Explain the question or topic: {{user_input}}".into(), format_text: "Up to 5 bullets and one analogy.".into(),
            variables: vec![Variable { name: "user_input".into(), label: "Topic".into(), required: true, default_value: "".into() }],
            is_built_in: true, created_at: 0, updated_at: 0,
        },
        Template {
            id: "builtin-summarize-material".into(), schema_version: 1, name: "Summarize material".into(), category: "Analysis".into(),
            context_text: "I need a concise summary of the provided text.".into(),
            task_text: "Summarize this source text: {{source_text}}\nFocus on: {{user_input}}".into(), format_text: "Main idea and 5 key points.".into(),
            variables: vec![
                Variable { name: "source_text".into(), label: "Source Text".into(), required: true, default_value: "".into() },
                Variable { name: "user_input".into(), label: "Focus".into(), required: true, default_value: "".into() }
            ],
            is_built_in: true, created_at: 0, updated_at: 0,
        },
        Template {
            id: "builtin-compare-concepts".into(), schema_version: 1, name: "Compare concepts".into(), category: "Analysis".into(),
            context_text: "I want to understand the differences and similarities between concepts.".into(),
            task_text: "Compare the following concepts: {{user_input}}. Please ask for missing items if context is needed.".into(), format_text: "Short table and brief takeaway.".into(),
            variables: vec![Variable { name: "user_input".into(), label: "Concepts".into(), required: true, default_value: "".into() }],
            is_built_in: true, created_at: 0, updated_at: 0,
        },
        Template {
            id: "builtin-practice-questions".into(), schema_version: 1, name: "Practice questions".into(), category: "Study".into(),
            context_text: "I am preparing for an assessment and need to test my knowledge.".into(),
            task_text: "Create practice questions from this topic or notes: {{user_input}}".into(), format_text: "5 questions; answers in a separate section at the bottom.".into(),
            variables: vec![Variable { name: "user_input".into(), label: "Topic or Notes".into(), required: true, default_value: "".into() }],
            is_built_in: true, created_at: 0, updated_at: 0,
        },
        Template {
            id: "builtin-improve-writing".into(), schema_version: 1, name: "Improve my writing".into(), category: "Review".into(),
            context_text: "I want to improve the clarity and flow of my writing.".into(),
            task_text: "Give feedback on this draft: {{rough_draft}}\nMy goal is: {{user_input}}".into(), format_text: "Revised text and 3 explained changes.".into(),
            variables: vec![
                Variable { name: "rough_draft".into(), label: "Rough Draft".into(), required: true, default_value: "".into() },
                Variable { name: "user_input".into(), label: "Goal".into(), required: true, default_value: "".into() }
            ],
            is_built_in: true, created_at: 0, updated_at: 0,
        }
    ]
}

fn validate_template_syntax(tmpl: &Template) -> Result<(), StoreError> {
    if tmpl.name.trim().is_empty() || tmpl.context_text.trim().is_empty() || tmpl.task_text.trim().is_empty() || tmpl.format_text.trim().is_empty() {
        return Err(StoreError::ValidationError("Name and core sections cannot be empty".into()));
    }
    
    let mut declared_names = HashSet::new();
    let mut has_user_input = false;

    for v in &tmpl.variables {
        let first_char = v.name.chars().next().unwrap_or(' ');
        if !(first_char.is_ascii_alphabetic() || first_char == '_') || !v.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(StoreError::ValidationError(format!("Invalid variable name: {}", v.name)));
        }
        if !declared_names.insert(&v.name) {
            return Err(StoreError::ValidationError(format!("Duplicate variable declaration: {}", v.name)));
        }
        if v.name == "user_input" {
            has_user_input = true;
        }
    }

    if !has_user_input {
        return Err(StoreError::ValidationError("user_input must be declared in variables".into()));
    }
    if !tmpl.task_text.contains("{{user_input}}") {
        return Err(StoreError::ValidationError(format!("Template '{}' missing {{{{user_input}}}} in Task section", tmpl.name)));
    }
    
    let mut extracted_vars = HashSet::new();
    let sections = [&tmpl.context_text, &tmpl.task_text, &tmpl.format_text];
    
    for text in sections {
        let mut chars = text.chars().peekable();
        let mut in_var = false;
        let mut current_var = String::new();
        
        while let Some(c) = chars.next() {
            if c == '{' && chars.peek() == Some(&'{') {
                chars.next(); 
                if in_var { return Err(StoreError::ValidationError("Nested double braces detected".into())); }
                in_var = true;
                current_var.clear();
            } else if c == '}' && chars.peek() == Some(&'}') {
                chars.next();
                if !in_var { return Err(StoreError::ValidationError("Unopened double braces detected".into())); }
                in_var = false;
                extracted_vars.insert(current_var.clone());
            } else if in_var {
                current_var.push(c);
            }
        }
        if in_var { return Err(StoreError::ValidationError("Unclosed double braces detected".into())); }
    }
    
    for ev in &extracted_vars {
        if !declared_names.contains(ev) {
            return Err(StoreError::ValidationError(format!("Undeclared placeholder detected: {}", ev)));
        }
    }
    for dv in &declared_names {
        if !extracted_vars.contains(*dv) {
            return Err(StoreError::ValidationError(format!("Unused variable declaration: {}", dv)));
        }
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// State Management
// -----------------------------------------------------------------------------

pub enum DbState {
    Ready(Connection),
    Corrupted,
    Restoring,
    Fatal(String),
}

pub struct PersistenceManager {
    db_state: Mutex<DbState>,
    db_path: PathBuf,
    worker: Mutex<Option<JoinHandle<()>>>,
    cancel_token: Arc<AtomicBool>,
    
    #[cfg(test)]
    pub inject_backup_promotion_failure: bool,
    #[cfg(test)]
    pub restore_barrier: Option<Arc<Barrier>>,
}

impl PersistenceManager {
    pub fn new(app_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_dir).map_err(|_| "Failed to create app directory")?;
        let db_path = app_dir.join("promptpal.sqlite");
        
        let state = match Self::initialize_connection(&db_path) {
            Ok(conn) => DbState::Ready(conn),
            Err(StoreError::DatabaseCorrupted) => DbState::Corrupted,
            Err(StoreError::AccessDenied) => return Err("Database is locked by another process".into()),
            Err(e) => return Err(e.to_string()),
        };

        let manager = Self {
            db_state: Mutex::new(state),
            db_path: db_path.clone(),
            worker: Mutex::new(None),
            cancel_token: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            inject_backup_promotion_failure: false,
            #[cfg(test)]
            restore_barrier: None,
        };

        if let DbState::Ready(_) = &*manager.db_state.lock().unwrap() {
            manager.spawn_backup_worker();
        }

        Ok(manager)
    }

    fn initialize_connection(path: &Path) -> Result<Connection, StoreError> {
        let log_path = path.with_extension("sqlite.diag.log");
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        
        // Mark the start of a new connection attempt and clear stale data for this run
        let _ = fs::write(&log_path, format!("--- RUN {} START ---\n", timestamp));

        let log_err = |phase: &str, e: &rusqlite::Error| {
            let (primary, extended) = match e {
                rusqlite::Error::SqliteFailure(ffi_err, _) => {
                    (format!("{:?}", ffi_err.code), ffi_err.extended_code)
                }
                _ => ("NonSqliteError".to_string(), 0),
            };
            if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&log_path) {
                use std::io::Write;
                let _ = writeln!(file, "Phase: {}\nPrimary: {}\nExtended: {}\n--- RUN END (FAILURE) ---\n", phase, primary, extended);
            }
        };

        let init_error = |phase: &str, e: &rusqlite::Error| {
            log_err(phase, e);
            let message = e.to_string().to_lowercase();
            if message.contains("locked") || message.contains("busy") {
                StoreError::AccessDenied
            } else {
                StoreError::DatabaseCorrupted
            }
        };

        let conn = Connection::open(path).map_err(|e| {
            init_error("Open_Connection", &e)
        })?;

        conn.busy_timeout(Duration::from_secs(5)).map_err(|e| init_error("Busy_Timeout", &e))?;

        let _: String = conn.query_row("PRAGMA journal_mode = WAL;", [], |row| row.get(0)).map_err(|e| init_error("Pragma_JournalMode", &e))?;

        conn.execute("PRAGMA synchronous = NORMAL;", []).map_err(|e| init_error("Pragma_Synchronous", &e))?;

        conn.execute("PRAGMA foreign_keys = ON;", []).map_err(|e| init_error("Pragma_ForeignKeys", &e))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS preferences (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 favorite_template_ids TEXT NOT NULL,
                 shortcut TEXT NOT NULL,
                 launch_at_startup INTEGER NOT NULL,
                 icon_position TEXT,
                 icon_visible INTEGER NOT NULL,
                 schema_version INTEGER NOT NULL,
                 data_revision INTEGER NOT NULL
             );", []
           ).map_err(|e| init_error("Schema_Preferences", &e))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS templates (
                 id TEXT PRIMARY KEY,
                 schema_version INTEGER NOT NULL,
                 name TEXT NOT NULL,
                 category TEXT NOT NULL,
                 context_text TEXT NOT NULL,
                 task_text TEXT NOT NULL,
                 format_text TEXT NOT NULL,
                 variables TEXT NOT NULL,
                 is_built_in INTEGER NOT NULL CHECK (is_built_in IN (0, 1)),
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );", []
           ).map_err(|e| init_error("Schema_Templates", &e))?;

        conn.execute(
            "INSERT OR IGNORE INTO preferences (id, favorite_template_ids, shortcut, launch_at_startup, icon_position, icon_visible, schema_version, data_revision) 
             VALUES (1, '[]', 'Ctrl+Shift+Space', 0, NULL, 1, 1, 1)", []
           ).map_err(|e| init_error("Seed_Insert", &e))?;

        let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| init_error("Query_QuickCheck", &e))?;
            
        if check.to_lowercase() != "ok" { 
            if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&log_path) {
                use std::io::Write;
                let _ = writeln!(file, "Phase: Eval_QuickCheck\nPrimary: NON_OK\nExtended: 0\n--- RUN END (FAILURE) ---\n");
            }
            return Err(StoreError::DatabaseCorrupted); 
        }

        // Successfully cleared all initialization and recovery gates
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&log_path) {
            use std::io::Write;
            let _ = writeln!(file, "--- RUN END (SUCCESS) ---\n");
        }

        Ok(conn)
    }

    // -----------------------------------------------------------------------------
    // IPC Commands (Load, Save, Reset)
    // -----------------------------------------------------------------------------

    pub fn load_snapshot(&self) -> Result<StoreSnapshot, StoreError> {
        let state_guard = self.db_state.lock().unwrap();
        match &*state_guard {
            DbState::Ready(conn) => Self::load_snapshot_inner(conn),
            DbState::Corrupted => Err(StoreError::DatabaseCorrupted),
            DbState::Restoring => Err(StoreError::LockedForRestoration),
            DbState::Fatal(msg) => Err(StoreError::Fatal(msg.clone())),
        }
    }

    fn load_snapshot_inner(conn: &Connection) -> Result<StoreSnapshot, StoreError> {
        let pref_tuple = conn.query_row(
            "SELECT favorite_template_ids, shortcut, launch_at_startup, icon_position, icon_visible, schema_version, data_revision FROM preferences WHERE id = 1",
            [],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i32>(2)?,
                row.get::<_, Option<String>>(3)?, row.get::<_, i32>(4)?, row.get::<_, u32>(5)?, row.get::<_, u32>(6)?
            ))
        ).map_err(|e| StoreError::Fatal(format!("Pref query failed: {}", e)))?;

        let icon_position = match pref_tuple.3 {
            Some(s) if s.trim() == "null" => None,
            Some(s) => Some(serde_json::from_str(&s).map_err(|e| StoreError::Fatal(format!("Parse icon_position failed: {}", e)))?),
            None => None,
        };

        let preferences = Preferences {
            favorite_template_ids: serde_json::from_str(&pref_tuple.0).map_err(|e| StoreError::Fatal(format!("Parse favorites failed: {}", e)))?,
            shortcut: pref_tuple.1,
            launch_at_startup: pref_tuple.2 != 0,
            icon_position,
            icon_visible: pref_tuple.4 != 0,
            schema_version: pref_tuple.5,
            data_revision: pref_tuple.6,
        };

        let mut tmpl_stmt = conn.prepare("SELECT id, schema_version, name, category, context_text, task_text, format_text, variables, is_built_in, created_at, updated_at FROM templates WHERE is_built_in = 0")
            .map_err(|e| StoreError::Fatal(format!("Template prepare failed: {}", e)))?;
            
        let custom_rows_iter = tmpl_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, u32>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?,
                row.get::<_, i32>(8)?, row.get::<_, u64>(9)?, row.get::<_, u64>(10)?
            ))
        }).map_err(|e| StoreError::Fatal(format!("Template query_map failed: {}", e)))?;

        let mut templates = get_canonical_builtins();
        for res in custom_rows_iter {
            let row = res.map_err(|e| StoreError::Fatal(format!("Template row read failed: {}", e)))?;
            let template_id = row.0.clone();
            templates.push(Template {
                id: row.0, schema_version: row.1, name: row.2, category: row.3, context_text: row.4, task_text: row.5, format_text: row.6,
                variables: serde_json::from_str(&row.7).map_err(|e| StoreError::Fatal(format!("Parse variables failed on template '{}': {}", template_id, e)))?,
                is_built_in: row.8 != 0, created_at: row.9, updated_at: row.10,
            });
        }

        Ok(StoreSnapshot { templates, preferences })
    }

    pub fn save_snapshot(&self, snapshot: &StoreSnapshot) -> Result<(), StoreError> {
        let state_guard = self.db_state.lock().unwrap();
        let conn_ref = match &*state_guard {
            DbState::Ready(c) => c,
            _ => return Err(StoreError::LockedForRestoration),
        };

        let tx = conn_ref.unchecked_transaction().map_err(|_| StoreError::AccessDenied)?;
        let current_rev: u32 = tx.query_row("SELECT data_revision FROM preferences WHERE id = 1", [], |row| row.get(0)).map_err(|_| StoreError::DatabaseCorrupted)?;
        if snapshot.preferences.data_revision != current_rev { return Err(StoreError::StaleData); }

        let canonicals = get_canonical_builtins();
        let mut custom_ids = Vec::new();

        for tmpl in &snapshot.templates {
            if let Some(canonical) = canonicals.iter().find(|c| c.id == tmpl.id) {
                if tmpl != canonical { return Err(StoreError::BuiltInImmutable); }
                continue; 
            }
            
            validate_template_syntax(tmpl)?;
            custom_ids.push(tmpl.id.clone());
            let vars_json = serde_json::to_string(&tmpl.variables).map_err(|_| StoreError::ValidationError("Variables serialization failed".into()))?;
            tx.execute(
                "INSERT INTO templates (id, schema_version, name, category, context_text, task_text, format_text, variables, is_built_in, created_at, updated_at) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET 
                 name=?3, category=?4, context_text=?5, task_text=?6, format_text=?7, variables=?8, updated_at=?10 WHERE is_built_in=0",
                (&tmpl.id, tmpl.schema_version, &tmpl.name, &tmpl.category, &tmpl.context_text, &tmpl.task_text, &tmpl.format_text, vars_json, tmpl.created_at, tmpl.updated_at)
            ).map_err(|_| StoreError::AccessDenied)?;
        }

        let id_list = custom_ids.iter().map(|id| format!("'{}'", id.replace("'", "''"))).collect::<Vec<_>>().join(",");
        let delete_sql = format!("DELETE FROM templates WHERE is_built_in = 0 AND id NOT IN ({})", if id_list.is_empty() { "''".to_string() } else { id_list });
        tx.execute(&delete_sql, []).map_err(|_| StoreError::AccessDenied)?;

        let favs = serde_json::to_string(&snapshot.preferences.favorite_template_ids).map_err(|_| StoreError::ValidationError("Bad favs".into()))?;
        let pos = serde_json::to_string(&snapshot.preferences.icon_position).unwrap_or_else(|_| "null".into());
        tx.execute(
            "UPDATE preferences SET favorite_template_ids=?1, shortcut=?2, launch_at_startup=?3, icon_position=?4, icon_visible=?5, data_revision=data_revision+1 WHERE id=1",
            (&favs, &snapshot.preferences.shortcut, snapshot.preferences.launch_at_startup as i32, &pos, snapshot.preferences.icon_visible as i32)
        ).map_err(|_| StoreError::AccessDenied)?;

        tx.commit().map_err(|_| StoreError::AccessDenied)?;
        
        self.spawn_backup_worker();
        drop(state_guard);
        Ok(())
    }

    pub fn reset_to_factory(&self) -> Result<(), StoreError> {
        {
            let mut state_guard = self.db_state.lock().unwrap();
            *state_guard = DbState::Restoring;
        }

        {
            let mut worker_guard = self.worker.lock().unwrap();
            self.cancel_token.store(true, Ordering::SeqCst);
            if let Some(handle) = worker_guard.take() {
                drop(worker_guard);
                let _ = handle.join(); 
            }
        }

        let remove_if_exists = |path: &PathBuf| -> Result<(), StoreError> {
            match path.try_exists() {
                Ok(true) => fs::remove_file(path).map_err(|e| StoreError::Fatal(format!("Failed to delete file: {}", e))),
                Ok(false) => Ok(()),
                Err(_) => Err(StoreError::Fatal("Access denied checking file metadata".into())),
            }
        };

        let db = &self.db_path;
        
        if let Err(e) = remove_if_exists(db)
            .and_then(|_| remove_if_exists(&db.with_extension("sqlite-wal")))
            .and_then(|_| remove_if_exists(&db.with_extension("sqlite-shm")))
            .and_then(|_| remove_if_exists(&db.with_extension("sqlite.bak")))
            .and_then(|_| remove_if_exists(&db.with_extension("sqlite.bak.old")))
            .and_then(|_| remove_if_exists(&db.with_extension("sqlite.tmp.bak")))
        {
            let mut state_guard = self.db_state.lock().unwrap();
            *state_guard = DbState::Fatal("Factory reset blocked by filesystem".into());
            return Err(e);
        }

        match Self::initialize_connection(db) {
            Ok(conn) => {
                let mut state_guard = self.db_state.lock().unwrap();
                *state_guard = DbState::Ready(conn);
                self.spawn_backup_worker();
                Ok(())
            }
            Err(_) => {
                let mut state_guard = self.db_state.lock().unwrap();
                *state_guard = DbState::Fatal("Factory reset failed".into());
                Err(StoreError::Fatal("Failed to recreate database".into()))
            }
        }
    }

    // -----------------------------------------------------------------------------
    // Verified Restoration & Rollback
    // -----------------------------------------------------------------------------

    pub fn restore_backup(&self) -> Result<(), StoreError> {
        {
            let mut state_guard = self.db_state.lock().unwrap();
            *state_guard = DbState::Restoring;
        }

        #[cfg(test)]
        if let Some(b) = &self.restore_barrier { b.wait(); }

        {
            let mut worker_guard = self.worker.lock().unwrap();
            self.cancel_token.store(true, Ordering::SeqCst);
            if let Some(handle) = worker_guard.take() {
                drop(worker_guard); 
                if handle.join().is_err() {
                    let mut state_guard = self.db_state.lock().unwrap();
                    *state_guard = DbState::Fatal("Backup worker panicked".into());
                    return Err(StoreError::Fatal("Worker panic".into()));
                }
            }
        }

        let bak_path = self.db_path.with_extension("sqlite.bak");
        match bak_path.try_exists() {
            Ok(true) => {},
            Ok(false) => return self.abort_restore_and_revert("Backup file missing"),
            Err(_) => return self.abort_restore_and_revert("Backup access denied"),
        }

        let temp_conn = match Connection::open_with_flags(&bak_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(c) => c,
            Err(_) => return self.abort_restore_and_revert("Cannot open backup"),
        };
        
        if Self::load_snapshot_inner(&temp_conn).is_err() {
            return self.abort_restore_and_revert("Backup data is invalid");
        }
        drop(temp_conn);

        let db_path = &self.db_path;
        let wal_path = db_path.with_extension("sqlite-wal");
        let shm_path = db_path.with_extension("sqlite-shm");
        let corrupt_db = db_path.with_extension("corrupt.db");
        let corrupt_wal = db_path.with_extension("corrupt.wal");
        let corrupt_shm = db_path.with_extension("corrupt.shm");

        if fs::rename(db_path, &corrupt_db).is_err() {
            return self.abort_restore_and_revert("Failed to move primary DB");
        }

        let mut wal_moved = false;
        match fs::rename(&wal_path, &corrupt_wal) {
            Ok(_) => wal_moved = true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Err(_) | Ok(true) = wal_path.try_exists() {
                    return self.trigger_fatal_rollback(wal_moved, false, "WAL status uncertain");
                }
            }
            Err(_) => return self.trigger_fatal_rollback(wal_moved, false, "WAL rename failed"),
        }

        let mut shm_moved = false;
        match fs::rename(&shm_path, &corrupt_shm) {
            Ok(_) => shm_moved = true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Err(_) | Ok(true) = shm_path.try_exists() {
                    return self.trigger_fatal_rollback(wal_moved, shm_moved, "SHM status uncertain");
                }
            }
            Err(_) => return self.trigger_fatal_rollback(wal_moved, shm_moved, "SHM rename failed"),
        }

        if fs::copy(&bak_path, db_path).is_err() {
            let _ = fs::remove_file(db_path);
            return self.trigger_fatal_rollback(wal_moved, shm_moved, "Backup copy failed");
        }

        let verification_result = match Self::initialize_connection(db_path) {
            Ok(new_conn) => {
                let load_res = Self::load_snapshot_inner(&new_conn);
                drop(new_conn); 
                if load_res.is_ok() { Ok(()) } else { Err("Restored data failed schema validation".to_string()) }
            },
            Err(_) => Err("Restored database failed integrity check".to_string())
        };

        if let Err(msg) = verification_result {
            let _ = fs::remove_file(db_path);
            let _ = fs::remove_file(&wal_path); 
            let _ = fs::remove_file(&shm_path);
            return self.trigger_fatal_rollback(wal_moved, shm_moved, &msg);
        }

        match Self::initialize_connection(db_path) {
            Ok(final_conn) => {
                let mut state_guard = self.db_state.lock().unwrap();
                *state_guard = DbState::Ready(final_conn);
                self.spawn_backup_worker();
                Ok(())
            },
            Err(_) => {
                let mut state_guard = self.db_state.lock().unwrap();
                *state_guard = DbState::Fatal("Reopen failed after validation".into());
                Err(StoreError::Fatal("Reopen failed".into()))
            }
        }
    }

    fn abort_restore_and_revert(&self, msg: &str) -> Result<(), StoreError> {
        let mut state_guard = self.db_state.lock().unwrap();
        *state_guard = DbState::Corrupted;
        Err(StoreError::ValidationError(msg.into()))
    }

    fn trigger_fatal_rollback(&self, wal_moved: bool, shm_moved: bool, msg: &str) -> Result<(), StoreError> {
        let db_path = &self.db_path;
        let mut success = true;

        if shm_moved && fs::rename(db_path.with_extension("corrupt.shm"), db_path.with_extension("sqlite-shm")).is_err() { success = false; }
        if wal_moved && fs::rename(db_path.with_extension("corrupt.wal"), db_path.with_extension("sqlite-wal")).is_err() { success = false; }
        if fs::rename(db_path.with_extension("corrupt.db"), db_path).is_err() { success = false; }

        let mut state_guard = self.db_state.lock().unwrap();
        if success {
            *state_guard = DbState::Corrupted;
            Err(StoreError::DatabaseCorrupted)
        } else {
            *state_guard = DbState::Fatal(format!("Rollback failed: {}", msg));
            Err(StoreError::Fatal(msg.into()))
        }
    }

    fn spawn_backup_worker(&self) {
        {
            let mut w = self.worker.lock().unwrap();
            if let Some(handle) = w.take() {
                self.cancel_token.store(true, Ordering::SeqCst);
                let _ = handle.join();
            }
        }

        self.cancel_token.store(false, Ordering::SeqCst);
        let cancel_token = Arc::clone(&self.cancel_token);
        let db_path = self.db_path.clone();
        
        #[cfg(test)]
        let inject_backup_failure = self.inject_backup_promotion_failure;

        let handle = thread::spawn(move || {
            if cancel_token.load(Ordering::SeqCst) { return; }

            let tmp_bak = db_path.with_extension("sqlite.tmp.bak");
            let final_bak = db_path.with_extension("sqlite.bak");
            let old_bak = db_path.with_extension("sqlite.bak.old");

            let mut export_success = false;
            if let Ok(src) = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
                if let Ok(mut dest) = Connection::open(&tmp_bak) {
                    if let Ok(backup) = rusqlite::backup::Backup::new(&src, &mut dest) {
                        if backup.step(-1).is_ok() { export_success = true; }
                    }
                }
            }

            if export_success {
                if let Ok(test_conn) = Connection::open_with_flags(&tmp_bak, OpenFlags::SQLITE_OPEN_READ_ONLY) {
                    if PersistenceManager::load_snapshot_inner(&test_conn).is_ok() {
                        drop(test_conn); 

                        let mut backed_up = false;
                        if final_bak.exists() {
                            let _ = fs::remove_file(&old_bak);
                            if fs::rename(&final_bak, &old_bak).is_ok() {
                                backed_up = true;
                            } else {
                                let _ = fs::remove_file(&tmp_bak);
                                return; 
                            }
                        }

                        #[cfg(test)]
                        let promote_result = if inject_backup_failure { Err(io::Error::new(io::ErrorKind::PermissionDenied, "mock")) } else { fs::rename(&tmp_bak, &final_bak) };
                        #[cfg(not(test))]
                        let promote_result = fs::rename(&tmp_bak, &final_bak);

                        if promote_result.is_err() {
                            if backed_up {
                                if fs::rename(&old_bak, &final_bak).is_err() {
                                    let _ = fs::copy(&old_bak, &final_bak); 
                                }
                            }
                        } else if backed_up {
                            let _ = fs::remove_file(&old_bak);
                        }
                    }
                }
            }
            let _ = fs::remove_file(&tmp_bak); 
        });

        let mut worker_guard = self.worker.lock().unwrap();
        *worker_guard = Some(handle);
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_restore_race_condition_barrier() {
        let temp_dir = std::env::temp_dir().join("promptpal_race_test_v3");
        let _ = fs::remove_dir_all(&temp_dir);
        let mut manager = PersistenceManager::new(temp_dir.clone()).unwrap();
        
        let barrier = Arc::new(Barrier::new(2));
        manager.restore_barrier = Some(Arc::clone(&barrier));

        let bak_path = temp_dir.join("promptpal.sqlite.bak");
        fs::copy(temp_dir.join("promptpal.sqlite"), &bak_path).unwrap();

        let m1 = Arc::new(manager);
        
        let m_restore = Arc::clone(&m1);
        let t1 = thread::spawn(move || {
            let _ = m_restore.restore_backup();
        });

        let m_save = Arc::clone(&m1);
        let b1 = Arc::clone(&barrier);
        let t2 = thread::spawn(move || {
            b1.wait(); 
            
            let snap = StoreSnapshot { templates: vec![], preferences: Preferences { favorite_template_ids: vec![], shortcut: "".into(), launch_at_startup: false, icon_position: None, icon_visible: true, schema_version: 1, data_revision: 1 } };
            let result = m_save.save_snapshot(&snap);
            assert_eq!(result, Err(StoreError::LockedForRestoration));
        });

        t1.join().unwrap();
        t2.join().unwrap();
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_backup_promotion_preserves_content_on_failure() {
        let temp_dir = std::env::temp_dir().join("promptpal_win_backup_content_v3");
        let _ = fs::remove_dir_all(&temp_dir);
        let mut manager = PersistenceManager::new(temp_dir.clone()).unwrap();
        manager.inject_backup_promotion_failure = false;
        
        let mut snap = manager.load_snapshot().unwrap();
        snap.preferences.shortcut = "CANARY_SHORTCUT".into();
        manager.save_snapshot(&snap).unwrap();
        
        if let Some(handle) = manager.worker.lock().unwrap().take() { handle.join().unwrap(); }

        let bak_path = temp_dir.join("promptpal.sqlite.bak");
        assert!(bak_path.exists());

        manager.inject_backup_promotion_failure = true;
        snap.preferences.shortcut = "NEW_DATA".into();
        snap.preferences.data_revision = snap.preferences.data_revision; 
        manager.save_snapshot(&snap).unwrap();

        if let Some(handle) = manager.worker.lock().unwrap().take() { handle.join().unwrap(); }

        assert!(bak_path.exists());
        let test_conn = Connection::open_with_flags(&bak_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let bak_snap = PersistenceManager::load_snapshot_inner(&test_conn).unwrap();
        
        assert_eq!(bak_snap.preferences.shortcut, "CANARY_SHORTCUT"); 
        assert!(!temp_dir.join("promptpal.sqlite.bak.old").exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_reset_to_factory_from_ready_clears_data() {
        let temp_dir = std::env::temp_dir().join("promptpal_test_reset_ready");
        let _ = fs::remove_dir_all(&temp_dir);
        let manager = PersistenceManager::new(temp_dir.clone()).unwrap();
        
        if let Some(handle) = manager.worker.lock().unwrap().take() { handle.join().unwrap(); }

        let mut snap = manager.load_snapshot().unwrap();
        snap.preferences.shortcut = "CUSTOM_SHORTCUT".into();
        snap.templates.push(Template {
            id: "custom-1".into(), schema_version: 1, name: "Custom".into(), category: "Misc".into(),
            context_text: "CTX".into(), task_text: "TASK {{user_input}}".into(), format_text: "FMT".into(),
            variables: vec![Variable { name: "user_input".into(), label: "Input".into(), required: true, default_value: "".into() }],
            is_built_in: false, created_at: 0, updated_at: 0,
        });
        manager.save_snapshot(&snap).unwrap();
        
        if let Some(handle) = manager.worker.lock().unwrap().take() { handle.join().unwrap(); }

        assert!(manager.reset_to_factory().is_ok());

        let clean_snap = manager.load_snapshot().unwrap();
        assert_eq!(clean_snap.preferences.shortcut, "Ctrl+Shift+Space"); 
        assert!(!clean_snap.templates.iter().any(|t| !t.is_built_in)); 
        assert!(clean_snap.templates.len() > 0); 
        
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_reset_to_factory_from_corrupted_rescues_state() {
        let temp_dir = std::env::temp_dir().join("promptpal_test_reset_corrupted");
        let _ = fs::remove_dir_all(&temp_dir);
        let manager = PersistenceManager::new(temp_dir.clone()).unwrap();
        
        if let Some(handle) = manager.worker.lock().unwrap().take() { handle.join().unwrap(); }
        
        {
            let mut state = manager.db_state.lock().unwrap();
            *state = DbState::Corrupted;
        }
        
        let result = manager.reset_to_factory();
        assert!(result.is_ok());
        
        let clean_snap = manager.load_snapshot();
        assert!(clean_snap.is_ok());
        
        let state = manager.db_state.lock().unwrap();
        assert!(matches!(*state, DbState::Ready(_)));
        
        let _ = fs::remove_dir_all(&temp_dir);
    }
}