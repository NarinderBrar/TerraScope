FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.4

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /srv/terrascope
COPY requirements.txt ./requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt
COPY app ./app

EXPOSE 8080
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]
