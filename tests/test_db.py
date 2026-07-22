import os
import pytest
import pandas as pd
from backend.app.db.excel_db import SheetsDatabase

TEST_DB_PATH = "tests/test_excel_db.xlsx"

@pytest.fixture
def test_db():
    # Setup - Remove previous test db if exists
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        
    db = SheetsDatabase()
    # Force use local Excel database with custom path
    db.use_local = True
    db.local_path = TEST_DB_PATH
    db._init_db()
    
    yield db
    
    # Teardown
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)

def test_init_db(test_db):
    assert os.path.exists(TEST_DB_PATH)
    with pd.ExcelFile(TEST_DB_PATH) as xls:
        assert "Articles" in xls.sheet_names
        assert "Companies" in xls.sheet_names
        assert "Procurement" in xls.sheet_names

def test_add_article_and_deduplicate(test_db):
    art = {
        "URL": "https://test.com/1",
        "Title": "Test Title",
        "Source": "Test Source",
        "Category": "Company",
        "Risk Score": 15,
        "Summary": "Brief description"
    }
    
    # 1. Add first article
    added = test_db.add_article(art)
    assert added is True
    
    articles = test_db.get_articles()
    assert len(articles) == 1
    assert articles[0]["Title"] == "Test Title"
    assert articles[0]["ID"] == 1
    
    # 2. Try adding duplicate URL
    added_duplicate = test_db.add_article(art)
    assert added_duplicate is False
    assert len(test_db.get_articles()) == 1

def test_add_company(test_db):
    comp = {
        "Company": "Apex Corp",
        "Industry": "Energy",
        "Risk Level": "High"
    }
    
    test_db.add_company(comp)
    companies = test_db.get_companies()
    assert len(companies) == 1
    assert companies[0]["Company"] == "Apex Corp"
    assert int(companies[0]["Mention Count"]) == 1
    
    # Add again to test count increment
    test_db.add_company(comp)
    companies = test_db.get_companies()
    assert len(companies) == 1
    assert int(companies[0]["Mention Count"]) == 2

def test_add_person(test_db):
    person = {
        "Name": "Sarah Jenkins",
        "Position": "CEO",
        "Organization": "Summit Ltd",
        "Event": "appointment"
    }
    test_db.add_person(person)
    people = test_db.get_people()
    assert len(people) == 1
    assert people[0]["Name"] == "Sarah Jenkins"

def test_add_procurement(test_db):
    contract = {
        "Agency": "FTC Agency",
        "Contractor": "Nova Energy",
        "Amount": "N5 Billion",
        "Project": "Grid Construction",
        "Source": "FGN Gazette"
    }
    test_db.add_procurement(contract)
    contracts = test_db.get_procurement()
    assert len(contracts) == 1
    assert contracts[0]["Contractor"] == "Nova Energy"
