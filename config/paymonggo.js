// config/paymongo.js
const axios = require('axios');

const paymongoClient = axios.create({
  baseURL: 'https://api.paymongo.com/v1',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`
  }
});

module.exports = paymongoClient;