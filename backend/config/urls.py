from posixpath import normpath

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import Http404, JsonResponse
from django.urls import include, path
from django.views.static import serve


def health(request):
    return JsonResponse({"status": "ok"})


def development_media(request, path, document_root):
    normalized = normpath(path.replace("\\", "/")).lstrip("/")
    if normalized.split("/", 1)[0].casefold() == "control-team":
        raise Http404
    return serve(request, path, document_root=document_root)


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("core.urls")),
    path("health/", health),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, view=development_media, document_root=settings.MEDIA_ROOT)
