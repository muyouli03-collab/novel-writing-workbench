"""给只读MCP适配层使用的小型接口，与网页共用现有ProjectStore。"""
from fastapi import APIRouter, HTTPException, Query
from .knowledge_card_query import CardQuery

router = APIRouter(prefix="/api/projects/{project_id}/knowledge/cards")
plot_router = APIRouter(prefix="/api/projects/{project_id}/knowledge/plots")


def run(project_id, max_chapter, call):
    from .main import _projects
    try:
        return call(CardQuery(_projects, project_id, max_chapter))
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0])) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("")
def search_cards(project_id: str, query: str = Query("", max_length=300), card_type: str = "",
                 limit: int = Query(8, ge=1, le=20), offset: int = Query(0, ge=0, le=100000),
                 max_chapter: int | None = Query(None, ge=0)):
    return run(project_id, max_chapter, lambda service: service.search(query, card_type, limit, offset))


@router.get("/{card_id}")
def get_card(project_id: str, card_id: str, max_chapter: int | None = Query(None, ge=0)):
    return run(project_id, max_chapter, lambda service: service.get(card_id))


@plot_router.get("")
def search_plots(project_id: str, query: str = Query("", max_length=300),
                 min_chapter: int | None = Query(None, ge=0), max_chapter: int | None = Query(None, ge=0),
                 limit: int = Query(8, ge=1, le=20), offset: int = Query(0, ge=0, le=100000)):
    return run(project_id, max_chapter, lambda service: service.search_plots(query, min_chapter, limit, offset))


@plot_router.get("/{plot_id}")
def get_plot(project_id: str, plot_id: str, max_chapter: int | None = Query(None, ge=0)):
    return run(project_id, max_chapter, lambda service: service.get_plot(plot_id))
