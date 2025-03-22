const swaggerJSDoc = require('swagger-jsdoc');

const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'API Documentation',
            version: '1.0.0',
            description: 'A sample API documentation using Swagger',
        },
        servers: [
            {
                url: 'http://3.25.192.169:3000',
                description: 'Production server',
            },
            {
                url: 'http://localhost:3000',
                description: 'Local development server',
            },
        ],
    },
    apis: ['./routes/*.js'], // Path to your route files (or main app file)
};

const swaggerDocs = swaggerJSDoc(swaggerOptions);

module.exports = swaggerDocs;
