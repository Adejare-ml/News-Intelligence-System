# Import all the models so that Base.metadata can see them
from backend.app.db.session import Base
from backend.app.models.user import User
from backend.app.models.article import Article
from backend.app.models.entity import Entity
from backend.app.models.event import Event, event_entities
from backend.app.models.relationship import Relationship
from backend.app.models.alert import Alert
from backend.app.models.watchlist import Watchlist
