# Generated by https://smithery.ai. See: https://smithery.ai/docs/config#dockerfile
FROM python:3.10-alpine

WORKDIR /app

# Copy the entire repository into the Docker image
COPY . .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Set environment variables (can be overridden at runtime)
ENV CANVAS_API_KEY=""
ENV GOOGLE_API_KEY=""

# Run the MCP server using canvas.py as the entry point
CMD ["python", "canvas.py"]
