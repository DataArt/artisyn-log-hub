package com.acme.orders;
public class OrderService {
  private final OrderRepository repo; private final PaymentGateway gateway;
  public OrderService(OrderRepository r, PaymentGateway g) { repo = r; gateway = g; }
  public void checkout(String orderId) {
    Order o = repo.findById(orderId);
    if (gateway.charge(o.getTotal())) { o.setStatus("PAID"); repo.save(o); }
  }
  public void cancel(String orderId) { Order o = repo.findById(orderId); o.setStatus("CANCELLED"); repo.save(o); }
}
