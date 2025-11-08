const express = require('express');
const router = express.Router();
const { sendInstallmentReminder } = require('../services/installmentreminder');

router.post('/test-email', async (req, res) => {
  try {
    await sendInstallmentReminder({
      email: 'garcia43jshua@gmail.com',
      first_name: 'Joshua',
      installment_number: 1,
      due_date: '2025-12-02',
      amount: 5500.00
    });
    
    res.json({ success: true, message: 'Test email sent!' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;