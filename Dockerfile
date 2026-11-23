# Imagen oficial ligera de Node.js 22 (Alpine Linux, menos de 100MB)
FROM node:22-alpine

# Directorio de la aplicación en el servidor
WORKDIR /app

# Copiar dependencias y paquetes
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el resto de archivos (código, frontend y estilos)
COPY . .

# Google Cloud Run inyecta la variable PORT (por defecto 8080)
ENV PORT=8080
EXPOSE 8080

# Comando de arranque del servidor
CMD ["node", "server.js"]
