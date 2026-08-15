import os
import json
import logging
import pandas as pd
from typing import List, Dict, Any
from datetime import datetime
from backend.app.core.config import settings

logger = logging.getLogger(__name__)

# Constants for sheets/tabs
SHEETS_CONFIG = {
    "Articles": ["ID", "Time", "Title", "Source", "URL", "Category", "Risk Score", "Summary", "Status", "Engine"],
    "Companies": ["Company", "Mention Count", "Last Seen", "Industry", "Risk Level"],
    "People": ["Name", "Position", "Organization", "Event", "Date"],
    "Government Agencies": ["Agency", "Event", "Article", "Date"],
    "Procurement": ["Agency", "Contractor", "Amount", "Project", "Source"],
    # Enriched beneficial-ownership schema. _append_row filters strictly to
    # these columns, so every field run_pipeline.py writes must appear here or
    # it is silently discarded between the LLM and the sheet.
    # "Voting Rights %" and "Share Band" support the CAMA 2020 band scheme
    # (Nigeria discloses from 5%, not the UK/FATF 25%); "Source" separates
    # extracted records from seeded demo rows so the dashboard can label them
    # honestly instead of inferring it from whether the list is empty.
    "Significant Control": [
        "Person Name", "Company", "Nature of Control", "Board Role", "Percentage",
        "Direct %", "Indirect %", "Voting Rights %", "Share Band", "Intermediate Entities",
        "PEP Status", "Risk Level", "Regulatory Filing Ref",
        "Verification Status", "Change Type", "Previous Holder", "Date", "Source"
    ],
    # "Archive File" resolves an edition to its exact archived markdown file.
    # Added after runs 2-4 of each day were found to overwrite run 1's archive.
    "Daily Reports": ["Date", "Total Articles", "High Risk", "Appointments", "Procurement", "Generated", "Archive File", "Content"]
}

def plan_header_migration(existing: List[str], target: List[str]) -> Dict[str, Any]:
    """Works out how to bring an existing header row up to the target schema.

    Rows are remapped by column *name*, never by position: new columns get
    inserted mid-schema (Board Role lands at index 3, ahead of Percentage), so
    copying positionally would silently shift every value one column left.
    """
    existing = [str(c).strip() for c in existing]
    added = [c for c in target if c not in existing]
    removed = [c for c in existing if c and c not in target]
    index_of = {name: i for i, name in enumerate(existing)}

    def remap(row: List[Any]) -> List[Any]:
        out = []
        for col in target:
            i = index_of.get(col)
            out.append(row[i] if i is not None and i < len(row) else "")
        return out

    return {
        "needs_migration": existing != target,
        "added": added,
        "removed": removed,
        "remap": remap,
    }


def retry_google_sheets_op(func, max_retries: int = 3, initial_delay: float = 2.0):
    """Executes a Google Sheets operation with exponential backoff retry logic."""
    import time
    delay = initial_delay
    for attempt in range(1, max_retries + 1):
        try:
            return func()
        except Exception as e:
            if attempt == max_retries:
                logger.error(f"Google Sheets operation failed after {max_retries} attempts: {e}")
                raise e
            logger.warning(f"Google Sheets API call failed (attempt {attempt}/{max_retries}): {e}. Retrying in {delay}s...")
            time.sleep(delay)
            delay *= 2

class SheetsDatabase:
    def __init__(self):
        self.use_local = True
        self.client = None
        self.spreadsheet = None
        self._cache = {}
        self.local_path = os.path.join(os.path.dirname(__file__), "excel_db.xlsx")
        
        # Make parent directories if they don't exist
        os.makedirs(os.path.dirname(self.local_path), exist_ok=True)
        
        # Try to initialize Google Sheets connection if settings exist
        if settings.GOOGLE_SERVICE_ACCOUNT_JSON and settings.SPREADSHEET_ID:
            try:
                import gspread
                from google.oauth2.service_account import Credentials
                
                scopes = [
                    'https://www.googleapis.com/auth/spreadsheets',
                    'https://www.googleapis.com/auth/drive'
                ]
                
                # Check if it's a JSON string or a file path
                json_str = settings.GOOGLE_SERVICE_ACCOUNT_JSON.strip()
                if json_str.startswith("{"):
                    creds_info = json.loads(json_str)
                    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
                else:
                    creds = Credentials.from_service_account_file(json_str, scopes=scopes)
                
                self.client = gspread.authorize(creds)
                self.spreadsheet = self.client.open_by_key(settings.SPREADSHEET_ID)
                self.use_local = False
                logger.info(f"Connected to Google Sheets: ID {settings.SPREADSHEET_ID}")
            except Exception as e:
                logger.error(f"Google Sheets connection failed: {e}. Falling back to local Excel database.")
                self.use_local = True
        else:
            logger.info("No Google Sheets credentials specified. Using local Excel database.")
            
        self._init_db()

    def _init_db(self):
        """Creates sheets/tabs and header rows if they are missing."""
        if self.use_local:
            if not os.path.exists(self.local_path):
                # Create a new workbook with blank sheets
                with pd.ExcelWriter(self.local_path, engine='openpyxl') as writer:
                    for sheet_name, columns in SHEETS_CONFIG.items():
                        df = pd.DataFrame(columns=columns)
                        df.to_excel(writer, sheet_name=sheet_name, index=False)
                logger.info(f"Initialized local Excel database at {self.local_path}")
            else:
                # Ensure all sheets exist
                try:
                    xls = pd.ExcelFile(self.local_path)
                    existing_sheets = xls.sheet_names
                    missing_sheets = [s for s in SHEETS_CONFIG if s not in existing_sheets]
                    
                    if missing_sheets:
                        # Append missing sheets
                        with pd.ExcelWriter(self.local_path, engine='openpyxl', mode='a', if_sheet_exists='replace') as writer:
                            for sheet_name in missing_sheets:
                                df = pd.DataFrame(columns=SHEETS_CONFIG[sheet_name])
                                df.to_excel(writer, sheet_name=sheet_name, index=False)
                        logger.info(f"Added missing sheets to Excel database: {missing_sheets}")
                except Exception as e:
                    logger.error(f"Failed to verify local sheets structure: {e}")
        else:
            # Google Sheets initialization
            try:
                worksheets = {ws.title: ws for ws in self.spreadsheet.worksheets()}
                for sheet_name, columns in SHEETS_CONFIG.items():
                    if sheet_name not in worksheets:
                        # Add worksheet
                        ws = self.spreadsheet.add_worksheet(title=sheet_name, rows="100", cols=str(len(columns)))
                        ws.append_row(columns)
                        logger.info(f"Created Google Sheet tab: '{sheet_name}'")
                    else:
                        self._migrate_worksheet_headers(worksheets[sheet_name], sheet_name, columns)
            except Exception as e:
                logger.error(f"Failed to initialize Google Sheets tabs: {e}")

    def _migrate_worksheet_headers(self, ws, sheet_name: str, columns: List[str]):
        """Brings an existing tab up to the current schema, preserving its rows.

        Without this, a schema change means rows are appended positionally
        against a stale header and every value lands under the wrong column.
        """
        try:
            values = ws.get_all_values()
            existing_header = values[0] if values else []

            # Blank tab: just write the header
            if not existing_header or not any(h.strip() for h in existing_header):
                ws.update(values=[columns], range_name="A1")
                logger.info(f"Wrote header row for empty tab '{sheet_name}'")
                return

            plan = plan_header_migration(existing_header, columns)
            if not plan["needs_migration"]:
                return

            logger.info(
                f"Migrating tab '{sheet_name}': +{plan['added']} -{plan['removed']}"
            )

            data_rows = values[1:]
            migrated = [plan["remap"](r) for r in data_rows]

            if ws.col_count < len(columns):
                ws.add_cols(len(columns) - ws.col_count)

            def _do_migrate():
                ws.clear()
                ws.update(values=[columns] + migrated, range_name="A1")

            retry_google_sheets_op(_do_migrate)
            self._cache.pop(sheet_name, None)
            logger.info(
                f"Migrated '{sheet_name}' to {len(columns)} columns, "
                f"{len(migrated)} rows preserved"
            )
        except Exception as e:
            # A failed migration must not take the whole run down
            logger.error(f"Header migration failed for '{sheet_name}': {e}")

    # ==========================================
    # GENERIC READING & WRITING HELPERS
    # ==========================================
    
    def _read_sheet(self, sheet_name: str) -> List[Dict[str, Any]]:
        """Reads all rows from a sheet as a list of dicts. Uses memory cache to prevent rate limits."""
        if sheet_name in self._cache:
            return self._cache[sheet_name]
            
        if self.use_local:
            try:
                if not os.path.exists(self.local_path):
                    return []
                df = pd.read_excel(self.local_path, sheet_name=sheet_name)
                # Fill NaN values with empty string
                df = df.fillna("")
                records = df.to_dict(orient="records")
                self._cache[sheet_name] = records
                return records
            except Exception as e:
                logger.error(f"Error reading local sheet '{sheet_name}': {e}")
                return []
        else:
            try:
                ws = self.spreadsheet.worksheet(sheet_name)
                records = ws.get_all_records()
                self._cache[sheet_name] = records
                return records
            except Exception as e:
                logger.error(f"Error reading Google Sheet '{sheet_name}': {e}")
                return []

    def _append_row(self, sheet_name: str, row_data: Dict[str, Any]):
        """Appends a single row matching columns to the specified sheet."""
        columns = SHEETS_CONFIG[sheet_name]
        row_values = [row_data.get(col, "") for col in columns]
        
        # Update cache immediately
        if sheet_name in self._cache:
            # We add a dict mapping columns to row values so the cache stays accurate
            self._cache[sheet_name].append(dict(zip(columns, row_values)))
            

        if self.use_local:
            try:
                df_existing = pd.DataFrame(columns=columns)
                if os.path.exists(self.local_path):
                    try:
                        df_existing = pd.read_excel(self.local_path, sheet_name=sheet_name)
                    except Exception:
                        pass
                
                df_new = pd.DataFrame([row_values], columns=columns)
                df_combined = pd.concat([df_existing, df_new], ignore_index=True)
                
                # Write back maintaining other sheets
                with pd.ExcelWriter(self.local_path, engine='openpyxl', mode='a', if_sheet_exists='replace') as writer:
                    df_combined.to_excel(writer, sheet_name=sheet_name, index=False)
            except Exception as e:
                logger.error(f"Error writing to local sheet '{sheet_name}': {e}")
        else:
            try:
                def _do_append():
                    ws = self.spreadsheet.worksheet(sheet_name)
                    stringified_values = []
                    for val in row_values:
                        if isinstance(val, (dict, list)):
                            stringified_values.append(json.dumps(val))
                        else:
                            stringified_values.append(str(val))
                    ws.append_row(stringified_values)

                retry_google_sheets_op(_do_append)
            except Exception as e:
                logger.error(f"Error appending to Google Sheet '{sheet_name}': {e}")

    # ==========================================
    # DATA INTERFACES
    # ==========================================

    def get_articles(self) -> List[Dict[str, Any]]:
        return self._read_sheet("Articles")

    def add_article(self, article: Dict[str, Any]) -> bool:
        """Adds an article if URL doesn't exist. Returns True if successfully added."""
        articles = self.get_articles()
        url = article.get("URL", "")
        
        # Deduplication check
        if any(row.get("URL") == url for row in articles):
            logger.info(f"Article URL already exists in database, skipping: {url}")
            return False
            
        # Assign auto increment ID
        next_id = 1
        if articles:
            ids = [int(r.get("ID")) for r in articles if str(r.get("ID")).isdigit()]
            if ids:
                next_id = max(ids) + 1
        
        article["ID"] = next_id
        article["Time"] = article.get("Time") or datetime.now().isoformat()
        article["Status"] = article.get("Status") or "Unread"
        
        self._append_row("Articles", article)
        logger.info(f"Saved new article to database: ID {next_id}")
        return True

    def get_companies(self) -> List[Dict[str, Any]]:
        return self._read_sheet("Companies")

    def add_company(self, company: Dict[str, Any]):
        """Adds a company or updates its mention count and last seen date."""
        companies = self.get_companies()
        name = company.get("Company", "").strip()
        if not name:
            return
            
        # Check if already exists
        match = None
        match_idx = -1
        for idx, row in enumerate(companies):
            if row.get("Company", "").lower() == name.lower():
                match = row
                match_idx = idx
                break
                
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        
        if match:
            # Update values
            mention_count = int(match.get("Mention Count", 1)) + 1
            match["Mention Count"] = mention_count
            match["Last Seen"] = now_str
            if company.get("Industry"):
                match["Industry"] = company["Industry"]
            if company.get("Risk Level"):
                match["Risk Level"] = company["Risk Level"]
                
            # If Google Sheets, update the cell, otherwise overwrite Excel tab
            if not self.use_local:
                try:
                    ws = self.spreadsheet.worksheet("Companies")
                    # Rows in sheets are 1-indexed, and header is row 1, so row is match_idx + 2
                    ws.update_cell(match_idx + 2, 2, mention_count)
                    ws.update_cell(match_idx + 2, 3, now_str)
                    if company.get("Industry"):
                        ws.update_cell(match_idx + 2, 4, company["Industry"])
                    if company.get("Risk Level"):
                        ws.update_cell(match_idx + 2, 5, company["Risk Level"])
                except Exception as e:
                    logger.error(f"Failed to update Google Sheet cell: {e}")
            else:
                # Overwrite the sheet with the updated records list
                columns = SHEETS_CONFIG["Companies"]
                df_updated = pd.DataFrame(companies, columns=columns)
                with pd.ExcelWriter(self.local_path, engine='openpyxl', mode='a', if_sheet_exists='replace') as writer:
                    df_updated.to_excel(writer, sheet_name="Companies", index=False)
        else:
            # Insert new company
            new_comp = {
                "Company": name,
                "Mention Count": 1,
                "Last Seen": now_str,
                "Industry": company.get("Industry") or "General",
                "Risk Level": company.get("Risk Level") or "Low"
            }
            self._append_row("Companies", new_comp)

    def get_people(self) -> List[Dict[str, Any]]:
        return self._read_sheet("People")

    def add_person(self, person: Dict[str, Any]):
        person["Date"] = person.get("Date") or datetime.now().strftime("%Y-%m-%d")
        self._append_row("People", person)

    def get_agencies(self) -> List[Dict[str, Any]]:
        return self._read_sheet("Government Agencies")

    def add_agency(self, agency: Dict[str, Any]):
        agency["Date"] = agency.get("Date") or datetime.now().strftime("%Y-%m-%d")
        self._append_row("Government Agencies", agency)

    def get_procurement(self) -> List[Dict[str, Any]]:
        return self._read_sheet("Procurement")

    def add_procurement(self, contract: Dict[str, Any]):
        self._append_row("Procurement", contract)

    def get_significant_control(self) -> List[Dict[str, Any]]:
        return self._read_sheet("Significant Control")

    # The fields that identify a disclosure rather than describe it. Two rows
    # agreeing on all of these are the same disclosure reported twice, not two
    # findings: the pipeline appends a row per extraction, so one disclosure
    # picked up from two articles in the same cycle landed twice. The register
    # carried an exact duplicate pair from 2026-08-05 for this reason, and the
    # cross-entity red flag then counted rows and reported a holder as
    # controlling four companies when it was two.
    #
    # Date is part of the key deliberately. The same holding reported again a
    # week later is a fresh sighting worth keeping; the same holding reported
    # twice in one day is bookkeeping.
    _PSC_IDENTITY = ("Person Name", "Company", "Nature of Control", "Percentage", "Date")

    @staticmethod
    def _psc_key(psc: Dict[str, Any]) -> tuple:
        return tuple(str(psc.get(f) or "").strip().lower() for f in SheetsDatabase._PSC_IDENTITY)

    def add_significant_control(self, psc: Dict[str, Any]):
        psc["Date"] = psc.get("Date") or datetime.now().strftime("%Y-%m-%d")

        # Reads come from the in-memory cache, which _append_row keeps current,
        # so this also catches duplicates written earlier in the same run --
        # which is where the observed pair came from. If the read fails the
        # cache is empty and the row is written: a duplicate is recoverable, a
        # dropped disclosure is not.
        key = self._psc_key(psc)
        for existing in self.get_significant_control():
            if self._psc_key(existing) == key:
                logger.info(
                    "Skipping duplicate significant-control row for %s / %s on %s",
                    psc.get("Person Name"), psc.get("Company"), psc.get("Date"),
                )
                return

        self._append_row("Significant Control", psc)

    def get_daily_reports(self) -> List[Dict[str, Any]]:
        return self._read_sheet("Daily Reports")

    def add_daily_report(self, report: Dict[str, Any]):
        report["Date"] = report.get("Date") or datetime.now().strftime("%Y-%m-%d")
        report["Generated"] = report.get("Generated") or datetime.now().strftime("%Y-%m-%d %H:%M")
        self._append_row("Daily Reports", report)

# Initialize database global
db = SheetsDatabase()
