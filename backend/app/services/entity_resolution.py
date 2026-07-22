from sqlalchemy.orm import Session
from difflib import SequenceMatcher
from backend.app.models.entity import Entity
from backend.app.models.relationship import Relationship
from typing import Optional, List, Dict, Any
import logging

logger = logging.getLogger(__name__)

class EntityResolutionService:
    @staticmethod
    def _similarity(s1: str, s2: str) -> float:
        """Returns string similarity between 0 and 1."""
        return SequenceMatcher(None, s1.lower(), s2.lower()).ratio()

    @classmethod
    def resolve_entity(cls, db: Session, name: str, entity_type: str) -> Entity:
        """Resolves an entity mention to an existing DB entity (via alias or fuzzy match) or creates a new one."""
        name = name.strip()
        if not name:
            return None

        # Normalize the name for lookup
        name_lower = name.lower()

        # 1. Look for exact name match
        entity = db.query(Entity).filter(Entity.type == entity_type, Entity.name == name).first()
        if entity:
            return entity

        # 2. Look for exact match within aliases (Postgres JSON field check)
        # For simplicity in SQLAlchemy, we can pull potential entities of that type and check Python-side
        # or do a SQL LIKE/JSON search. Pulling active entities of that type is highly reliable for our scale.
        candidates = db.query(Entity).filter(Entity.type == entity_type).all()
        
        # Check alias lists
        for cand in candidates:
            aliases = cand.aliases or []
            if any(name_lower == a.lower() for a in aliases):
                # Update aliases if casing is different or add to details
                return cand

        # 3. Fuzzy matching with existing candidates
        best_match = None
        highest_score = 0.0

        for cand in candidates:
            # Check similarity with canonical name
            score = cls._similarity(name, cand.name)
            if score > highest_score:
                highest_score = score
                best_match = cand

            # Check similarity with aliases
            for alias in (cand.aliases or []):
                score = cls._similarity(name, alias)
                if score > highest_score:
                    highest_score = score
                    best_match = cand

        # If similarity is very high (e.g. > 80%), resolve to this entity and add as alias
        if highest_score > 0.80 and best_match:
            logger.info(f"Resolved '{name}' to existing entity '{best_match.name}' (Confidence: {highest_score:.2f})")
            aliases = list(best_match.aliases or [])
            if name not in aliases and name != best_match.name:
                aliases.append(name)
                best_match.aliases = aliases
                db.add(best_match)
                db.commit()
            return best_match

        # 4. No match found, create a new canonical entity
        logger.info(f"Creating new entity '{name}' of type '{entity_type}'")
        new_entity = Entity(
            name=name,
            type=entity_type,
            aliases=[name],
            details={},
            risk_score=10.0 if entity_type in ["company", "agency"] else 0.0, # default base risk
            influence_score=20.0 if entity_type == "agency" else 5.0
        )
        
        # Add basic defaults in details JSON based on type
        if entity_type == "company":
            new_entity.details = {"status": "Active", "board_members": [], "executives": []}
        elif entity_type == "person":
            new_entity.details = {"career_history": [], "education": [], "current_position": None}
        elif entity_type == "agency":
            new_entity.details = {"jurisdiction": "National", "leadership": []}

        db.add(new_entity)
        db.commit()
        db.refresh(new_entity)
        return new_entity

    @classmethod
    def resolve_and_store_relationships(
        cls, db: Session, article_id: int, extracted_relationships: List[Dict[str, Any]]
    ) -> List[Relationship]:
        """Resolves subject and object strings to Entity records and saves the relationships."""
        stored_rels = []
        for rel in extracted_relationships:
            subj_name = rel["subject"]
            pred = rel["predicate"]
            obj_name = rel["object"]
            conf = rel.get("confidence_score", 1.0)

            # Heuristically determine type of subject and object
            # E.g. if predicate is "appointed", subject is typically "agency" or "company" and object is "person"
            subj_type = "company"
            obj_type = "person"
            if pred in ["resigned from", "retired from"]:
                subj_type = "person"
                obj_type = "company"
            elif pred in ["acquired", "partnered with"]:
                subj_type = "company"
                obj_type = "company"
            elif pred in ["investigating", "suing"]:
                subj_type = "agency"
                obj_type = "company"

            # Resolve entities
            subj_entity = cls.resolve_entity(db, subj_name, subj_type)
            obj_entity = cls.resolve_entity(db, obj_name, obj_type)

            # Check if this relationship already exists for this article to avoid duplicates
            existing = db.query(Relationship).filter(
                Relationship.article_id == article_id,
                Relationship.subject_name == subj_name,
                Relationship.predicate == pred,
                Relationship.object_name == obj_name
            ).first()

            if not existing:
                db_rel = Relationship(
                    article_id=article_id,
                    subject_id=subj_entity.id if subj_entity else None,
                    subject_name=subj_name,
                    predicate=pred,
                    object_id=obj_entity.id if obj_entity else None,
                    object_name=obj_name,
                    confidence_score=conf
                )
                db.add(db_rel)
                stored_rels.append(db_rel)

                # SIDE-EFFECT: Update career/company timelines dynamically based on relationships!
                if pred == "appointed" and subj_entity and obj_entity:
                    # Update Person's current position and career history
                    person_details = obj_entity.details or {}
                    history = person_details.get("career_history", [])
                    
                    # Avoid duplicate records in history
                    entry = {"company": subj_entity.name, "role": "Executive", "year": "2026"}
                    if entry not in history:
                        history.append(entry)
                        person_details["career_history"] = history
                        person_details["current_position"] = f"Executive at {subj_entity.name}"
                        obj_entity.details = person_details
                        db.add(obj_entity)
                        
                    # Update Company's board/exec list
                    company_details = subj_entity.details or {}
                    execs = company_details.get("executives", [])
                    if obj_entity.name not in execs:
                        execs.append(obj_entity.name)
                        company_details["executives"] = execs
                        subj_entity.details = company_details
                        db.add(subj_entity)

                elif pred == "resigned from" and subj_entity and obj_entity:
                    # subj is Person, obj is Company
                    person_details = subj_entity.details or {}
                    person_details["current_position"] = f"Former Executive at {obj_entity.name}"
                    subj_entity.details = person_details
                    db.add(subj_entity)

                    company_details = obj_entity.details or {}
                    execs = company_details.get("executives", [])
                    if subj_entity.name in execs:
                        execs.remove(subj_entity.name)
                        company_details["executives"] = execs
                        obj_entity.details = company_details
                        db.add(obj_entity)

        if stored_rels:
            db.commit()
            
        return stored_rels
