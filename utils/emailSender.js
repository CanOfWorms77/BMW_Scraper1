const nodemailer = require('nodemailer');

async function sendEmail({ subject, body }) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.ALERT_EMAIL_USER,
            pass: process.env.ALERT_EMAIL_PASS
        }
    });

    console.log("EMAIL length:", process.env.ALERT_EMAIL_USER?.length);
    console.log("PASS length:", process.env.ALERT_EMAIL_PASS?.length);
    console.log("Defined:", {
        EMAIL: !!process.env.ALERT_EMAIL_USER,
        PASS: !!process.env.ALERT_EMAIL_PASS
    })

    const auth = {
        user: process.env.ALERT_EMAIL_USER,
        pass: process.env.ALERT_EMAIL_PASS
    };

    console.log("AUTH DEBUG:", {
        user: auth.user ? "***" + auth.user.slice(-5) : null,
        pass: auth.pass ? "********" : null
    });


    const mailOptions = {
        from: `"BMW Alert Bot" <${process.env.ALERT_EMAIL_USER}>`,
        to: process.env.ALERT_EMAIL_TO,
        subject,
        text: body
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent: ${subject}`);
    } catch (err) {
        console.error('❌ Email failed:', err);
    }
}

module.exports = { sendEmail };