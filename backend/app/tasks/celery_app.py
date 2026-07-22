from celery import Celery
from celery.schedules import crontab
from backend.app.core.config import settings

celery_app = Celery(
    "news_intel_tasks",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL
)

# Optional settings
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

# Auto-discover tasks in this package
celery_app.autodiscover_tasks(["backend.app.tasks"])

# Scheduled Tasks (Celery Beat)
celery_app.conf.beat_schedule = {
    "ingest-news-every-30-min": {
        "task": "backend.app.tasks.tasks.ingest_news_task",
        "schedule": crontab(minute="*/30"), # every 30 minutes
    },
    "generate-psc-intelligence-report": {
        "task": "backend.app.tasks.tasks.generate_psc_intelligence_report_task",
        "schedule": crontab(hour="10,14,18", minute="0"), # 10:00 AM, 2:00 PM, 6:00 PM daily
    }
}
