// Example: Using the Stripe Payment Endpoints from the Frontend

/**
 * Example 1: Create a checkout session and redirect to Stripe Checkout
 */
async function handlePayment() {
  try {
    // Replace with your actual price ID from Stripe Dashboard
    const priceId = 'price_1234567890';
    
    const response = await fetch('http://localhost:3001/api/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        priceId: priceId,
        successUrl: `${window.location.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${window.location.origin}/cancel`,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create checkout session');
    }

    const { url } = await response.json();
    
    // Redirect to Stripe Checkout
    window.location.href = url;
  } catch (error) {
    console.error('Payment error:', error);
    alert('Failed to initiate payment: ' + error.message);
  }
}

/**
 * Example 2: Handle success page after payment
 */
function handlePaymentSuccess() {
  // This runs on your success page
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('session_id');
  
  if (sessionId) {
    console.log('Payment successful! Session ID:', sessionId);
    // You can display a success message to the user
    // The webhook on the server will handle fulfillment
    document.getElementById('success-message').innerText = 
      'Thank you for your payment! Your order is being processed.';
  }
}

/**
 * Example 3: React component for payment button
 */
function PaymentButton({ priceId, productName, amount }) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const handleClick = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('http://localhost:3001/api/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          priceId: priceId,
          successUrl: `${window.location.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: window.location.href,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create checkout session');
      }

      const { url } = await response.json();
      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <div>
      <button 
        onClick={handleClick} 
        disabled={loading}
        style={{
          padding: '12px 24px',
          fontSize: '16px',
          backgroundColor: '#5469d4',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1
        }}
      >
        {loading ? 'Processing...' : `Buy ${productName} - $${amount}`}
      </button>
      {error && (
        <p style={{ color: 'red', marginTop: '8px' }}>
          Error: {error}
        </p>
      )}
    </div>
  );
}

/**
 * Example 4: Handling errors
 */
async function createCheckoutWithErrorHandling(priceId) {
  try {
    const response = await fetch('http://localhost:3001/api/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        priceId: priceId,
        successUrl: `${window.location.origin}/success`,
        cancelUrl: `${window.location.origin}/cancel`,
      }),
    });

    if (response.status === 503) {
      throw new Error('Payment processing is currently unavailable. Please try again later.');
    }

    if (response.status === 400) {
      const error = await response.json();
      throw new Error(error.error || 'Invalid payment request');
    }

    if (!response.ok) {
      throw new Error('An unexpected error occurred. Please try again.');
    }

    const { url } = await response.json();
    return url;
  } catch (error) {
    console.error('Checkout error:', error);
    throw error;
  }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    handlePayment,
    handlePaymentSuccess,
    PaymentButton,
    createCheckoutWithErrorHandling
  };
}
