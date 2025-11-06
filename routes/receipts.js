// routes/receipts.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const PDFDocument = require('pdfkit'); // npm install pdfkit

router.get('/:transaction_log_id', async (req, res) => {
  try {
    const { transaction_log_id } = req.params;
    
    // Get transaction details
    const result = await pool.query(`
      SELECT 
        at.*,
        s.first_name,
        s.last_name,
        s.student_id,
        p.reference_no,
        p.method,
        p.payment_date
      FROM account_transactions at
      JOIN accounts a ON at.account_id = a.account_id
      JOIN students s ON a.student_id = s.student_id
      LEFT JOIN payments p ON at.payment_id = p.payment_id
      WHERE at.transaction_log_id = $1
    `, [transaction_log_id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Receipt not found' });
    }
    
    const transaction = result.rows[0];
    
    // Generate PDF receipt
    const doc = new PDFDocument({ margin: 50 });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt-${transaction_log_id}.pdf`);
    
    doc.pipe(res);
    
    // Header
    doc.fontSize(20).text('PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Receipt No: ${transaction_log_id}`, { align: 'right' });
    doc.text(`Date: ${new Date(transaction.payment_date).toLocaleDateString()}`, { align: 'right' });
    doc.moveDown(2);
    
    // Student Info
    doc.fontSize(12).text('Student Information:', { underline: true });
    doc.fontSize(10);
    doc.text(`Name: ${transaction.first_name} ${transaction.last_name}`);
    doc.text(`Student ID: ${transaction.student_id}`);
    doc.moveDown();
    
    // Payment Details
    doc.fontSize(12).text('Payment Details:', { underline: true });
    doc.fontSize(10);
    doc.text(`Transaction Type: ${transaction.transaction_type.toUpperCase()}`);
    doc.text(`Amount Paid: ₱${parseFloat(transaction.amount).toFixed(2)}`);
    doc.text(`Payment Method: ${transaction.method || 'N/A'}`);
    doc.text(`Reference No: ${transaction.reference_no || 'N/A'}`);
    doc.text(`Description: ${transaction.description}`);
    doc.moveDown();
    
    // Balance Info
    doc.fontSize(12).text('Account Balance:', { underline: true });
    doc.fontSize(10);
    doc.text(`Previous Balance: ₱${parseFloat(transaction.balance_before).toFixed(2)}`);
    doc.text(`Current Balance: ₱${parseFloat(transaction.balance_after).toFixed(2)}`);
    doc.moveDown(2);
    
    // Footer
    doc.fontSize(8).text('This is a computer-generated receipt.', { align: 'center' });
    
    doc.end();
    
  } catch (error) {
    console.error('Receipt generation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all receipts for a student
router.get('/student/:student_id', async (req, res) => {
  try {
    const { student_id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        at.transaction_log_id,
        at.transaction_type,
        at.amount,
        at.description,
        at.created_at,
        p.reference_no,
        p.method
      FROM account_transactions at
      JOIN accounts a ON at.account_id = a.account_id
      LEFT JOIN payments p ON at.payment_id = p.payment_id
      WHERE a.student_id = $1
      ORDER BY at.created_at DESC
    `, [student_id]);
    
    res.json({
      success: true,
      receipts: result.rows
    });
    
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;