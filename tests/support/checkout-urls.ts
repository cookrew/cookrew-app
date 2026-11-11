/**
 * Addresses a hostile door might hand back as "the Checkout page", and one
 * real one. Shared by every test of the rule and of the places that open it.
 */

export const HOSTILE: readonly unknown[] = [
  'file:///Applications/Calculator.app#/cs_x',
  'file:///etc/passwd#/cs_test_1',
  'smb://evil.example/share/cs_test_1',
  'javascript:alert(1)//checkout.stripe.com/cs_test_1',
  'data:text/html,<script>1</script>/cs_test_1',
  'http://checkout.stripe.com/c/pay/cs_test_1',
  'https://checkout.stripe.com.evil.example/c/pay/cs_test_1',
  'https://evil.example/#https://checkout.stripe.com/cs_x',
  'https://evil.example/?next=https://checkout.stripe.com/c/pay/cs_test_1',
  'https://checkout.stripe.com@evil.example/cs_x',
  'https://user:pw@checkout.stripe.com/c/pay/cs_test_1',
  'https://checkout.stripe.com:8443/c/pay/cs_test_1',
  'https://xcheckout.stripe.com/c/pay/cs_test_1',
  'https://stripe.com/c/pay/cs_test_1',
  '//checkout.stripe.com/c/pay/cs_test_1',
  'checkout.stripe.com/c/pay/cs_test_1',
  ' https://checkout.stripe.com/c/pay/cs_test_1',
  '',
  null,
  undefined,
  42,
  { href: 'https://checkout.stripe.com/c/pay/cs_test_1' }
]

export const GOOD = 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0'
