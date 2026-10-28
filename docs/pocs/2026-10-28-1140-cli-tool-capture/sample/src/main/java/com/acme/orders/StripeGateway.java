package com.acme.orders;
public class StripeGateway implements PaymentGateway {
  public boolean charge(double amount) { return amount > 0; }
}
