const sgMail = require('@sendgrid/mail');
const { createClient } = require('@supabase/supabase-js');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sendInstallmentReminder(student) {
  const periodNames = {
    1: 'Prelim',
    2: 'Midterms', 
    3: 'Semi-Finals',
    4: 'Finals'
  };

  const msg = {
    to: student.email,
    from: process.env.SENDGRID_FROM,
    subject: `${periodNames[student.installment_number]} Payment Reminder`,
    html: `
      <p>Hi ${student.first_name},</p>
      <p>This is a reminder that your <strong>${periodNames[student.installment_number]}</strong> installment payment is due.</p>
      <p><strong>Amount Due:</strong> ₱${student.amount}</p>
      <p><strong>Due Date:</strong> ${new Date(student.due_date).toLocaleDateString()}</p>
      <p>Please settle your payment on or before the due date.</p>
    `
  };

  try {
    // Send email
    await sgMail.send(msg);
    console.log('Email sent successfully to', student.email);

    // Save notification to database
    await saveNotificationToDatabase(student, periodNames[student.installment_number]);
    
  } catch (error) {
    console.error('Error sending reminder:', error);
    throw error;
  }
}

async function saveNotificationToDatabase(student, period) {
  try {
    // Get student_id from email
    const { data: studentData } = await supabase
      .from('students')
      .select('student_id')
      .eq('email', student.email)
      .single();

    if (!studentData) {
      console.error('Student not found for email:', student.email);
      return;
    }

    // Insert notification
    const { error } = await supabase
      .from('student_notifications')
      .insert({
        student_id: studentData.student_id,
        type: 'payment_reminder',
        title: `${period} Payment Reminder`,
        message: `Your ${period} installment payment of ₱${student.amount} is due on ${new Date(student.due_date).toLocaleDateString()}`,
        is_read: false,
        created_at: new Date().toISOString()
      });

    if (error) throw error;
    console.log('Notification saved to database');
  } catch (error) {
    console.error('Error saving notification:', error);
  }
}

module.exports = { sendInstallmentReminder };