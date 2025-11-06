const cron = require('node-cron');
const { sendInstallmentReminder } = require('./installmentreminder');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

// Run every Monday at 9 AM
cron.schedule('0 9 * * 1', async () => {
  console.log('Checking for upcoming installments...');
  
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('payment_installments')
    .select(`
      email:students(email),
      first_name:students(first_name),
      installment_number,
      due_date,
      amount,
      enrollments!inner(semester_id)
    `)
    .eq('status', 'pending')
    .in('enrollments.semester_id', [4, 5])
    .gte('due_date', today)
    .lte('due_date', sevenDaysLater);
  
  if (error) {
    console.error('Error fetching installments:', error);
    return;
  }
  
  for (const installment of data) {
    try {
      await sendInstallmentReminder({
        email: installment.email,
        first_name: installment.first_name,
        installment_number: installment.installment_number,
        due_date: installment.due_date,
        amount: installment.amount
      });
      console.log(`Sent reminder to ${installment.email}`);
    } catch (error) {
      console.error(`Failed to send to ${installment.email}:`, error);
    }
  }
});